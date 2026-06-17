// Package pki is the gateway's internal certificate authority. It issues the
// short-lived X.509 client certificates that reverse-connect Gateway Agents (and
// later, cross-machine workers) authenticate with over mTLS — replacing the M2
// bearer secret. See docs/security-architecture.md §6.
//
// This file is the pure-crypto core (no DB, no KMS): generate a CA, sign CSRs
// into leaf certs, round-trip PEM. Persistence (the pki_ca row + KMS-enveloped
// key) and the issuance flow (OTT → CSR → cert) are layered on top elsewhere so
// this stays trivially testable. The embedded CA is the default; a step-ca
// adapter can satisfy the same Issuer interface later without touching callers.
package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"time"
)

const (
	// caValidity is the embedded CA certificate's lifetime. The CA outlives many
	// generations of 24h leaf certs.
	caValidity = 5 * 365 * 24 * time.Hour
	// DefaultLeafValidity is the default lifetime of an issued agent certificate.
	// Short by design: a stolen key's exposure window is bounded to one renewal
	// cycle (§4/§6). Agents auto-renew at ~1/3 of this.
	DefaultLeafValidity = 24 * time.Hour
)

// CA is an issuing certificate authority backed by an ECDSA P-256 key.
type CA struct {
	cert    *x509.Certificate
	key     *ecdsa.PrivateKey
	certPEM []byte
}

// NewCA generates a fresh self-signed issuing CA. commonName labels it in
// certificate viewers (e.g. "Wayfort Agent CA").
func NewCA(commonName string) (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("pki: generate ca key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: commonName, Organization: []string{"Wayfort"}},
		NotBefore:             now.Add(-5 * time.Minute), // small skew tolerance
		NotAfter:              now.Add(caValidity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true, // issues leaves only, never sub-CAs
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("pki: self-sign ca: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &CA{
		cert:    cert,
		key:     key,
		certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}, nil
}

// LoadCA reconstructs a CA from its persisted PEM cert + EC private key.
func LoadCA(certPEM, keyPEM []byte) (*CA, error) {
	cblk, _ := pem.Decode(certPEM)
	if cblk == nil || cblk.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("pki: invalid ca cert pem")
	}
	cert, err := x509.ParseCertificate(cblk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("pki: parse ca cert: %w", err)
	}
	kblk, _ := pem.Decode(keyPEM)
	if kblk == nil {
		return nil, fmt.Errorf("pki: invalid ca key pem")
	}
	key, err := x509.ParseECPrivateKey(kblk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("pki: parse ca key: %w", err)
	}
	return &CA{cert: cert, key: key, certPEM: certPEM}, nil
}

// IssueOptions parametrises a leaf certificate.
type IssueOptions struct {
	// CommonName labels the subject (we use the agent's stable name).
	CommonName string
	// URISANs carry the machine identity (e.g. "agent://<id>") so the verifier
	// can bind the cert to a registry row beyond the fingerprint.
	URISANs []string
	// Validity overrides DefaultLeafValidity when non-zero.
	Validity time.Duration
}

// IssuedCert is the result of signing a CSR.
type IssuedCert struct {
	CertPEM     []byte
	Serial      string // lowercase hex, matches model.GatewayAgent.CertSerial
	Fingerprint string // sha256 hex of the DER, matches GatewayAgent.Fingerprint
	NotAfter    time.Time
}

// Issue signs a CSR into a short-lived client-auth leaf certificate. The CSR's
// public key and subject CN are taken from the request; everything security-
// relevant (validity, key usage, CA constraints) is set by the CA, never by the
// requester. The CSR signature is verified before issuance.
func (c *CA) Issue(csr *x509.CertificateRequest, opts IssueOptions) (*IssuedCert, error) {
	if err := csr.CheckSignature(); err != nil {
		return nil, fmt.Errorf("pki: csr signature invalid: %w", err)
	}
	validity := opts.Validity
	if validity <= 0 {
		validity = DefaultLeafValidity
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	uris, err := parseURISANs(opts.URISANs)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: opts.CommonName, Organization: []string{"Wayfort Agent"}},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.Add(validity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		URIs:         uris,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, csr.PublicKey, c.key)
	if err != nil {
		return nil, fmt.Errorf("pki: sign leaf: %w", err)
	}
	sum := sha256.Sum256(der)
	return &IssuedCert{
		CertPEM:     pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		Serial:      serialHex(serial),
		Fingerprint: hex.EncodeToString(sum[:]),
		NotAfter:    tmpl.NotAfter,
	}, nil
}

// IssueServerCert mints a server certificate (ServerAuth) for the agent-facing
// mTLS listener, signed by the CA. Agents pin the CA bundle as their RootCAs, so
// a server cert from this CA is trusted without a public PKI. hosts are the DNS
// names / IPs agents connect to (the gateway's agent-facing address). The
// generated key lives only in the returned tls.Certificate.
func (c *CA) IssueServerCert(hosts []string, validity time.Duration) (tls.Certificate, error) {
	if validity <= 0 {
		validity = 90 * 24 * time.Hour
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("pki: server key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return tls.Certificate{}, err
	}
	cn := "wayfort-gateway"
	if len(hosts) > 0 {
		cn = hosts[0]
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: cn, Organization: []string{"Wayfort Gateway"}},
		NotBefore:    now.Add(-5 * time.Minute),
		NotAfter:     now.Add(validity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else if h != "" {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &key.PublicKey, c.key)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("pki: sign server cert: %w", err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{
		Certificate: [][]byte{der, c.cert.Raw}, // leaf + CA so clients can chain
		PrivateKey:  key,
		Leaf:        leaf,
	}, nil
}

// Bundle returns the CA certificate PEM — the trust anchor the agent pins and
// the gateway loads into its mTLS ClientCAs pool.
func (c *CA) Bundle() []byte { return c.certPEM }

// CertPEM returns the CA certificate PEM (for persistence).
func (c *CA) CertPEM() []byte { return c.certPEM }

// KeyPEM returns the CA private key as SEC1 PEM (for KMS-enveloped persistence).
// Treat the result as highly sensitive — it is the trust root for every agent.
func (c *CA) KeyPEM() ([]byte, error) {
	der, err := x509.MarshalECPrivateKey(c.key)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), nil
}

// Certificate returns the CA's own certificate (for surfacing subject/expiry).
func (c *CA) Certificate() *x509.Certificate { return c.cert }

// Pool returns an x509.CertPool containing the CA cert, for use as a mTLS
// ClientCAs / RootCAs pool.
func (c *CA) Pool() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(c.cert)
	return p
}

func randomSerial() (*big.Int, error) {
	// 128-bit random serial (RFC 5280 ≤ 20 octets, positive).
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	n, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("pki: serial: %w", err)
	}
	return n.Add(n, big.NewInt(1)), nil // ensure > 0
}

func serialHex(n *big.Int) string {
	return fmt.Sprintf("%x", n)
}
