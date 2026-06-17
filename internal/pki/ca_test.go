package pki

import (
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"
)

func TestCA_IssueAndVerifyChain(t *testing.T) {
	ca, err := NewCA("Wayfort Agent CA")
	if err != nil {
		t.Fatalf("new ca: %v", err)
	}

	// Agent side: generate a key + CSR.
	_, csrPEM, err := GenerateKeyAndCSR("edge-agent-1")
	if err != nil {
		t.Fatalf("gen csr: %v", err)
	}
	csr, err := ParseCSR(csrPEM)
	if err != nil {
		t.Fatalf("parse csr: %v", err)
	}

	// Gateway CA signs it into a short-lived client cert bound to agent 42.
	issued, err := ca.Issue(csr, IssueOptions{
		CommonName: "edge-agent-1",
		URISANs:    []string{AgentURI(42)},
		Validity:   24 * time.Hour,
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if issued.Serial == "" || len(issued.Fingerprint) != 64 {
		t.Fatalf("bad issued metadata: %+v", issued)
	}

	// Parse the issued leaf and verify it chains to the CA — exactly what the
	// gateway's mTLS handshake does with ClientCAs = ca.Pool().
	blk, _ := pem.Decode(issued.CertPEM)
	leaf, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatalf("parse leaf: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{
		Roots:     ca.Pool(),
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}); err != nil {
		t.Fatalf("leaf does not chain to CA: %v", err)
	}

	// Security properties: client-auth only, bound to the agent URI, CA-set validity.
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Fatalf("leaf must be client-auth only, got %v", leaf.ExtKeyUsage)
	}
	if leaf.IsCA {
		t.Fatal("leaf must not be a CA")
	}
	if len(leaf.URIs) != 1 || leaf.URIs[0].String() != "agent://42" {
		t.Fatalf("leaf must carry agent://42 SAN, got %v", leaf.URIs)
	}
	if d := time.Until(leaf.NotAfter); d > 25*time.Hour || d < 23*time.Hour {
		t.Fatalf("leaf validity should be ~24h, got %s", d)
	}
}

func TestCA_RejectsUnrelatedLeaf(t *testing.T) {
	ca1, _ := NewCA("CA-1")
	ca2, _ := NewCA("CA-2")
	_, csrPEM, _ := GenerateKeyAndCSR("x")
	csr, _ := ParseCSR(csrPEM)
	issued, _ := ca1.Issue(csr, IssueOptions{CommonName: "x"})

	blk, _ := pem.Decode(issued.CertPEM)
	leaf, _ := x509.ParseCertificate(blk.Bytes)
	// A cert from CA-1 must NOT verify against CA-2's pool.
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: ca2.Pool(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err == nil {
		t.Fatal("a foreign CA's leaf must not verify")
	}
}

func TestCA_PEMRoundTrip(t *testing.T) {
	ca, err := NewCA("RoundTrip CA")
	if err != nil {
		t.Fatalf("new ca: %v", err)
	}
	keyPEM, err := ca.KeyPEM()
	if err != nil {
		t.Fatalf("key pem: %v", err)
	}
	reloaded, err := LoadCA(ca.CertPEM(), keyPEM)
	if err != nil {
		t.Fatalf("load ca: %v", err)
	}
	// The reloaded CA must issue certs that still chain to the original cert.
	_, csrPEM, _ := GenerateKeyAndCSR("y")
	csr, _ := ParseCSR(csrPEM)
	issued, err := reloaded.Issue(csr, IssueOptions{CommonName: "y"})
	if err != nil {
		t.Fatalf("issue after reload: %v", err)
	}
	blk, _ := pem.Decode(issued.CertPEM)
	leaf, _ := x509.ParseCertificate(blk.Bytes)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: ca.Pool(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		t.Fatalf("reloaded CA's leaf must chain to original pool: %v", err)
	}
}

func TestCA_RejectsTamperedCSR(t *testing.T) {
	ca, _ := NewCA("CA")
	_, csrPEM, _ := GenerateKeyAndCSR("z")
	csr, _ := ParseCSR(csrPEM)
	// Corrupt the CSR signature so CheckSignature fails.
	csr.Signature[0] ^= 0xFF
	if _, err := ca.Issue(csr, IssueOptions{CommonName: "z"}); err == nil {
		t.Fatal("issuing a CSR with a bad signature must fail")
	}
}
