package pki

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

// Store persists the CA material and the issued-certificate ledger. Satisfied
// by *repo.PKIRepo; an interface keeps this package decoupled from GORM and
// trivially fakeable in tests.
type Store interface {
	ActiveCA(ctx context.Context) (*model.PKICA, error)
	CreateCA(ctx context.Context, ca *model.PKICA) error
	RecordCert(ctx context.Context, cert *model.PKICertificate) error
	IsRevoked(ctx context.Context, serial string) (bool, error)
	RevokeBySerial(ctx context.Context, serial, reason string, at time.Time) error
	RevokeBySubject(ctx context.Context, kind string, subjectID uint64, reason string, at time.Time) error
}

// Sealer seals/opens the CA private key (KMS-enveloped). Satisfied by
// pkgcrypto.Vault. Keeping it an interface avoids a hard dependency on the
// secrets stack here.
type Sealer interface {
	Seal(plain []byte) ([]byte, error)
	Open(sealed []byte) ([]byte, error)
}

// SubjectAgent labels certificates issued to reverse-connect agents.
const SubjectAgent = "agent"

// Service is the gateway's issuing CA with persistence + revocation. It loads
// (or, on first boot, generates) the embedded CA, keeping the private key only
// in memory and KMS-sealed at rest.
type Service struct {
	ca    *CA
	store Store
}

// Bootstrap loads the active CA from the store, or generates and persists a new
// one on first boot (the key sealed via the provided Sealer). Idempotent across
// restarts: the same CA is reused so previously-issued certs keep verifying.
func Bootstrap(ctx context.Context, store Store, sealer Sealer, commonName string) (*Service, error) {
	row, err := store.ActiveCA(ctx)
	if err != nil {
		return nil, fmt.Errorf("pki: load active ca: %w", err)
	}
	if row != nil {
		keyPEM, err := sealer.Open(row.KeySealed)
		if err != nil {
			return nil, fmt.Errorf("pki: unseal ca key: %w", err)
		}
		ca, err := LoadCA([]byte(row.CertPEM), keyPEM)
		if err != nil {
			return nil, err
		}
		return &Service{ca: ca, store: store}, nil
	}

	// First boot — mint a CA and persist it with the key sealed.
	ca, err := NewCA(commonName)
	if err != nil {
		return nil, err
	}
	keyPEM, err := ca.KeyPEM()
	if err != nil {
		return nil, err
	}
	sealed, err := sealer.Seal(keyPEM)
	if err != nil {
		return nil, fmt.Errorf("pki: seal ca key: %w", err)
	}
	if err := store.CreateCA(ctx, &model.PKICA{
		CertPEM:   string(ca.CertPEM()),
		KeySealed: sealed,
		Active:    true,
	}); err != nil {
		return nil, fmt.Errorf("pki: persist ca: %w", err)
	}
	return &Service{ca: ca, store: store}, nil
}

// Issue signs a CSR for a subject and appends it to the ledger. The returned
// cert is short-lived and client-auth only (see CA.Issue).
func (s *Service) Issue(ctx context.Context, subjectKind string, subjectID uint64, commonName string, csr *x509.CertificateRequest, validity time.Duration) (*IssuedCert, error) {
	uris := []string(nil)
	if subjectKind == SubjectAgent {
		uris = []string{AgentURI(subjectID)}
	}
	issued, err := s.ca.Issue(csr, IssueOptions{
		CommonName: commonName,
		URISANs:    uris,
		Validity:   validity,
	})
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if err := s.store.RecordCert(ctx, &model.PKICertificate{
		Serial:      issued.Serial,
		SubjectKind: subjectKind,
		SubjectID:   subjectID,
		Fingerprint: issued.Fingerprint,
		NotBefore:   now,
		NotAfter:    issued.NotAfter,
	}); err != nil {
		return nil, fmt.Errorf("pki: record cert: %w", err)
	}
	return issued, nil
}

// Revoke marks a single certificate revoked by serial.
func (s *Service) Revoke(ctx context.Context, serial, reason string) error {
	return s.store.RevokeBySerial(ctx, serial, reason, time.Now())
}

// RevokeSubject revokes every live certificate held by a subject (used when an
// agent is revoked/deleted so a stolen key can't be renewed back to life).
func (s *Service) RevokeSubject(ctx context.Context, subjectKind string, subjectID uint64, reason string) error {
	return s.store.RevokeBySubject(ctx, subjectKind, subjectID, reason, time.Now())
}

// IsRevoked reports whether a serial is revoked (fail-closed on unknown serials).
func (s *Service) IsRevoked(ctx context.Context, serial string) (bool, error) {
	return s.store.IsRevoked(ctx, serial)
}

// Bundle returns the CA cert PEM (trust anchor handed to agents).
func (s *Service) Bundle() []byte { return s.ca.Bundle() }

// CAInfo summarises the active CA for the admin console.
type CAInfo struct {
	Subject   string    `json:"subject"`
	NotBefore time.Time `json:"not_before"`
	NotAfter  time.Time `json:"not_after"`
	Bundle    string    `json:"bundle"`
	Mode      string    `json:"mode"` // "embedded" (step-ca adapter would report "step-ca")
}

// Info returns the CA metadata for GET /pki/ca.
func (s *Service) Info() CAInfo {
	cert := s.ca.Certificate()
	return CAInfo{
		Subject:   cert.Subject.CommonName,
		NotBefore: cert.NotBefore,
		NotAfter:  cert.NotAfter,
		Bundle:    string(s.ca.Bundle()),
		Mode:      "embedded",
	}
}

// Pool returns the CA cert pool for the gateway's mTLS ClientCAs.
func (s *Service) Pool() *x509.CertPool { return s.ca.Pool() }

// ServerTLSConfig builds the *tls.Config for the agent-facing mTLS listener: a
// CA-signed server certificate plus client-cert verification against the same
// CA. ClientAuth is VerifyClientCertIfGiven — the listener accepts a connection
// with no client cert (so /agent/v1/enroll can run with only an OTT) but, when a
// cert IS presented, requires it to chain to our CA. Per-route handlers enforce
// that tunnel/renew actually carry a verified cert. hosts are the agent-facing
// DNS/IP names for the server cert SANs.
func (s *Service) ServerTLSConfig(hosts []string) (*tls.Config, error) {
	srv, err := s.ca.IssueServerCert(hosts, 0)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{srv},
		ClientCAs:    s.ca.Pool(),
		ClientAuth:   tls.VerifyClientCertIfGiven,
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// ClientTLSConfig builds the *tls.Config an agent uses to dial the gateway: its
// own client certificate plus the CA bundle pinned as RootCAs (so it only trusts
// a gateway whose server cert this CA signed). Used by cmd/gateway-agent.
func ClientTLSConfig(certPEM, keyPEM, caBundlePEM []byte, serverName string) (*tls.Config, error) {
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("pki: load client cert: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caBundlePEM) {
		return nil, fmt.Errorf("pki: invalid ca bundle")
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      roots,
		ServerName:   serverName,
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// SerialHexOf returns the lowercase-hex serial of a certificate, matching the
// ledger's Serial column — used by the mTLS path to look up revocation.
func SerialHexOf(cert *x509.Certificate) string {
	return fmt.Sprintf("%x", cert.SerialNumber)
}

// AgentIDFromCert extracts the agent id from a verified client certificate's
// "agent://<id>" URI SAN. Returns an error if absent/malformed — the tunnel
// path uses this to cross-check the cert against the registry beyond the
// fingerprint.
func AgentIDFromCert(cert *x509.Certificate) (uint64, error) {
	for _, u := range cert.URIs {
		if u.Scheme == "agent" {
			id, err := strconv.ParseUint(strings.TrimPrefix(u.Opaque, "//"), 10, 64)
			if err == nil && id != 0 {
				return id, nil
			}
			// url.Parse puts "42" into Host for "agent://42"; handle both.
			if h := strings.TrimSpace(u.Host); h != "" {
				if id, err := strconv.ParseUint(h, 10, 64); err == nil {
					return id, nil
				}
			}
		}
	}
	return 0, fmt.Errorf("pki: no agent URI SAN in certificate")
}
