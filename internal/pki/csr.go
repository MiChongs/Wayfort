package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"net/url"
)

// AgentURI builds the canonical URI SAN that binds a certificate to an agent
// registry row, e.g. "agent://42". The tunnel verifier can cross-check this
// against the agent id it resolved by fingerprint.
func AgentURI(agentID uint64) string {
	return fmt.Sprintf("agent://%d", agentID)
}

// parseURISANs turns SAN strings into *url.URL for the certificate template.
func parseURISANs(sans []string) ([]*url.URL, error) {
	if len(sans) == 0 {
		return nil, nil
	}
	out := make([]*url.URL, 0, len(sans))
	for _, s := range sans {
		u, err := url.Parse(s)
		if err != nil {
			return nil, fmt.Errorf("pki: bad URI SAN %q: %w", s, err)
		}
		out = append(out, u)
	}
	return out, nil
}

// GenerateKeyAndCSR produces a fresh ECDSA P-256 key and a CSR for it with the
// given common name. Returns the private key PEM (SEC1) and the CSR PEM. The
// agent calls this at enrollment/renewal; the gateway's CA signs the CSR. The
// private key never leaves the agent.
func GenerateKeyAndCSR(commonName string) (keyPEM, csrPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("pki: generate key: %w", err)
	}
	tmpl := &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: commonName},
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, key)
	if err != nil {
		return nil, nil, fmt.Errorf("pki: create csr: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	csrPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
	return keyPEM, csrPEM, nil
}

// ParseCSR decodes a PEM-encoded CSR.
func ParseCSR(csrPEM []byte) (*x509.CertificateRequest, error) {
	blk, _ := pem.Decode(csrPEM)
	if blk == nil || blk.Type != "CERTIFICATE REQUEST" {
		return nil, fmt.Errorf("pki: invalid csr pem")
	}
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("pki: parse csr: %w", err)
	}
	return csr, nil
}
