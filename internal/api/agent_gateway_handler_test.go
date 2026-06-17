package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/agentgw"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/pki"
	"github.com/michongs/wayfort/internal/repo"
	"go.uber.org/zap"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// idSealer is an identity Sealer for tests (the real KMS envelope is covered in
// the secrets package).
type idSealer struct{}

func (idSealer) Seal(p []byte) ([]byte, error) { return p, nil }
func (idSealer) Open(s []byte) ([]byte, error) { return s, nil }

func newAgentHandler(t *testing.T) (*AgentGatewayHandler, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(
		&model.GatewayAgent{}, &model.AgentEnrollToken{}, &model.Domain{},
		&model.PKICA{}, &model.PKICertificate{},
	); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pkiSvc, err := pki.Bootstrap(context.Background(), repo.NewPKIRepo(db), idSealer{}, "Test CA")
	if err != nil {
		t.Fatalf("pki bootstrap: %v", err)
	}
	return &AgentGatewayHandler{
		Agents:    repo.NewGatewayAgentRepo(db),
		Tokens:    repo.NewAgentEnrollTokenRepo(db),
		Domains:   repo.NewDomainRepo(db),
		Registry:  agentgw.NewRegistry(),
		Logger:    zap.NewNop(),
		GatewayID: "gw-test",
		PKI:       pkiSvc,
	}, db
}

// testCSR returns a fresh CSR PEM for enroll requests.
func testCSR(t *testing.T) string {
	t.Helper()
	_, csrPEM, err := pki.GenerateKeyAndCSR("edge")
	if err != nil {
		t.Fatalf("gen csr: %v", err)
	}
	return string(csrPEM)
}

func postEnroll(t *testing.T, h *AgentGatewayHandler, body any) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/agent/v1/enroll", h.Enroll)
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/agent/v1/enroll", bytes.NewReader(buf))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestEnroll_ValidTokenIssuesCertToPendingAgent(t *testing.T) {
	h, _ := newAgentHandler(t)
	if err := h.Tokens.Create(t.Context(), &model.AgentEnrollToken{
		DomainID: 9, TokenHash: sha256hex("secret-ott"), CreatedBy: 1,
		ExpiresAt: time.Now().Add(15 * time.Minute),
	}); err != nil {
		t.Fatalf("seed token: %v", err)
	}

	w := postEnroll(t, h, map[string]string{
		"token": "secret-ott", "name": "edge-1", "csr_pem": testCSR(t),
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var resp enrollResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.AgentID == 0 || resp.DomainID != 9 || resp.CertPEM == "" || resp.CABundle == "" {
		t.Fatalf("unexpected enroll response %+v", resp)
	}

	// The agent must be PENDING (not schedulable) with its cert fingerprint stored.
	agent, _ := h.Agents.FindByID(t.Context(), resp.AgentID)
	if agent == nil || agent.Status != model.AgentPending {
		t.Fatalf("agent should be pending, got %+v", agent)
	}
	if agent.Schedulable() {
		t.Fatal("freshly enrolled agent must NOT be schedulable")
	}
	if agent.Fingerprint == "" || agent.CertSerial == "" || agent.CertExpiresAt == nil {
		t.Fatalf("agent should have cert metadata recorded, got %+v", agent)
	}
}

func TestEnroll_MissingCSRRejected(t *testing.T) {
	h, _ := newAgentHandler(t)
	if err := h.Tokens.Create(t.Context(), &model.AgentEnrollToken{
		DomainID: 1, TokenHash: sha256hex("t"), CreatedBy: 1, ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// No csr_pem → 400, and the token must NOT be consumed (so a retry works).
	w := postEnroll(t, h, map[string]string{"token": "t"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing csr must be 400, got %d", w.Code)
	}
}

func TestEnroll_InvalidTokenRejected(t *testing.T) {
	h, _ := newAgentHandler(t)
	w := postEnroll(t, h, map[string]string{"token": "nope", "csr_pem": testCSR(t)})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 for unknown token, got %d", w.Code)
	}
}

func TestEnroll_TokenIsSingleUseAcrossRequests(t *testing.T) {
	h, _ := newAgentHandler(t)
	if err := h.Tokens.Create(t.Context(), &model.AgentEnrollToken{
		DomainID: 1, TokenHash: sha256hex("once"), CreatedBy: 1,
		ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if w := postEnroll(t, h, map[string]string{"token": "once", "csr_pem": testCSR(t)}); w.Code != http.StatusCreated {
		t.Fatalf("first enroll want 201, got %d (%s)", w.Code, w.Body.String())
	}
	if w := postEnroll(t, h, map[string]string{"token": "once", "csr_pem": testCSR(t)}); w.Code != http.StatusUnauthorized {
		t.Fatalf("second enroll must be 401 (token burned), got %d", w.Code)
	}
}
