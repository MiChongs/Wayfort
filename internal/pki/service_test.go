package pki

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"sync"
	"testing"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// fakeStore is an in-memory Store. fakeSealer is an identity sealer — the real
// KMS envelope is exercised in the secrets package; here we only verify the CA
// lifecycle wiring.
type fakeStore struct {
	mu    sync.Mutex
	ca    *model.PKICA
	certs map[string]*model.PKICertificate
}

func newFakeStore() *fakeStore { return &fakeStore{certs: map[string]*model.PKICertificate{}} }

func (f *fakeStore) ActiveCA(context.Context) (*model.PKICA, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ca, nil
}
func (f *fakeStore) CreateCA(_ context.Context, ca *model.PKICA) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *ca
	cp.ID = 1
	f.ca = &cp
	return nil
}
func (f *fakeStore) RecordCert(_ context.Context, c *model.PKICertificate) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *c
	f.certs[c.Serial] = &cp
	return nil
}
func (f *fakeStore) IsRevoked(_ context.Context, serial string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.certs[serial]
	if !ok {
		return true, nil // fail-closed
	}
	return c.RevokedAt != nil, nil
}
func (f *fakeStore) RevokeBySerial(_ context.Context, serial, reason string, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.certs[serial]; ok && c.RevokedAt == nil {
		c.RevokedAt = &at
		c.RevokeReason = reason
	}
	return nil
}
func (f *fakeStore) RevokeBySubject(_ context.Context, kind string, id uint64, reason string, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.certs {
		if c.SubjectKind == kind && c.SubjectID == id && c.RevokedAt == nil {
			c.RevokedAt = &at
			c.RevokeReason = reason
		}
	}
	return nil
}

type fakeSealer struct{}

func (fakeSealer) Seal(p []byte) ([]byte, error) { return append([]byte("sealed:"), p...), nil }
func (fakeSealer) Open(s []byte) ([]byte, error) { return s[len("sealed:"):], nil }

func issueAgentCert(t *testing.T, svc *Service, agentID uint64) *IssuedCert {
	t.Helper()
	_, csrPEM, err := GenerateKeyAndCSR("edge")
	if err != nil {
		t.Fatalf("gen csr: %v", err)
	}
	csr, _ := ParseCSR(csrPEM)
	issued, err := svc.Issue(context.Background(), SubjectAgent, agentID, "edge", csr, 24*time.Hour)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return issued
}

func TestService_BootstrapPersistsAndReuses(t *testing.T) {
	store := newFakeStore()
	sealer := fakeSealer{}

	svc1, err := Bootstrap(context.Background(), store, sealer, "JS Agent CA")
	if err != nil {
		t.Fatalf("bootstrap 1: %v", err)
	}
	if store.ca == nil || store.ca.KeySealed == nil {
		t.Fatal("CA must be persisted with a sealed key")
	}
	issued := issueAgentCert(t, svc1, 7)

	// Restart: a second Bootstrap must LOAD the same CA (not mint a new one), so
	// the cert issued by svc1 still chains to svc2's pool.
	svc2, err := Bootstrap(context.Background(), store, sealer, "JS Agent CA")
	if err != nil {
		t.Fatalf("bootstrap 2: %v", err)
	}
	blk, _ := pem.Decode(issued.CertPEM)
	leaf, _ := x509.ParseCertificate(blk.Bytes)
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:     svc2.Pool(),
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		t.Fatalf("cert from first CA must verify against reloaded CA: %v", err)
	}
}

func TestService_LedgerAndRevocation(t *testing.T) {
	store := newFakeStore()
	svc, err := Bootstrap(context.Background(), store, fakeSealer{}, "CA")
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	issued := issueAgentCert(t, svc, 42)

	if rev, _ := svc.IsRevoked(context.Background(), issued.Serial); rev {
		t.Fatal("freshly issued cert must not be revoked")
	}
	// Unknown serial is fail-closed (treated revoked).
	if rev, _ := svc.IsRevoked(context.Background(), "deadbeef"); !rev {
		t.Fatal("unknown serial must be treated as revoked")
	}

	if err := svc.Revoke(context.Background(), issued.Serial, "test"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if rev, _ := svc.IsRevoked(context.Background(), issued.Serial); !rev {
		t.Fatal("revoked cert must report revoked")
	}
}

func TestService_RevokeSubjectKillsAllCerts(t *testing.T) {
	store := newFakeStore()
	svc, _ := Bootstrap(context.Background(), store, fakeSealer{}, "CA")
	c1 := issueAgentCert(t, svc, 9)
	c2 := issueAgentCert(t, svc, 9) // a renewal — same agent, new cert

	if err := svc.RevokeSubject(context.Background(), SubjectAgent, 9, "agent revoked"); err != nil {
		t.Fatalf("revoke subject: %v", err)
	}
	for _, c := range []*IssuedCert{c1, c2} {
		if rev, _ := svc.IsRevoked(context.Background(), c.Serial); !rev {
			t.Fatalf("cert %s should be revoked after subject revoke", c.Serial)
		}
	}
}

func TestService_MutualTLSHandshake(t *testing.T) {
	store := newFakeStore()
	svc, _ := Bootstrap(context.Background(), store, fakeSealer{}, "CA")

	// Server config (gateway 8443 side): CA-signed server cert + client-cert
	// verification against the CA. SAN = 127.0.0.1 so the client's ServerName check passes.
	srvCfg, err := svc.ServerTLSConfig([]string{"127.0.0.1"})
	if err != nil {
		t.Fatalf("server tls config: %v", err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", srvCfg)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	// Agent side: issue a client cert from the CA, build the client config that
	// pins the CA bundle as RootCAs.
	keyPEM, csrPEM, _ := GenerateKeyAndCSR("agent-7")
	csr, _ := ParseCSR(csrPEM)
	issued, err := svc.Issue(context.Background(), SubjectAgent, 7, "agent-7", csr, 24*time.Hour)
	if err != nil {
		t.Fatalf("issue client cert: %v", err)
	}
	cliCfg, err := ClientTLSConfig(issued.CertPEM, keyPEM, svc.Bundle(), "127.0.0.1")
	if err != nil {
		t.Fatalf("client tls config: %v", err)
	}

	gotCert := make(chan *x509.Certificate, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		tc := conn.(*tls.Conn)
		if err := tc.Handshake(); err != nil {
			return
		}
		state := tc.ConnectionState()
		if len(state.PeerCertificates) > 0 {
			gotCert <- state.PeerCertificates[0]
		}
	}()

	cli, err := tls.Dial("tcp", ln.Addr().String(), cliCfg)
	if err != nil {
		t.Fatalf("mutual TLS handshake failed: %v", err)
	}
	defer cli.Close()

	select {
	case peer := <-gotCert:
		id, err := AgentIDFromCert(peer)
		if err != nil || id != 7 {
			t.Fatalf("server should see agent-7 client cert, got id=%d err=%v", id, err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server never completed the mTLS handshake")
	}
}

func TestService_AgentIDFromCert(t *testing.T) {
	store := newFakeStore()
	svc, _ := Bootstrap(context.Background(), store, fakeSealer{}, "CA")
	issued := issueAgentCert(t, svc, 123)
	blk, _ := pem.Decode(issued.CertPEM)
	leaf, _ := x509.ParseCertificate(blk.Bytes)

	id, err := AgentIDFromCert(leaf)
	if err != nil {
		t.Fatalf("extract agent id: %v", err)
	}
	if id != 123 {
		t.Fatalf("want agent id 123, got %d", id)
	}
	// SerialHexOf must match the ledger serial.
	if SerialHexOf(leaf) != issued.Serial {
		t.Fatalf("serial mismatch: cert=%s ledger=%s", SerialHexOf(leaf), issued.Serial)
	}
}
