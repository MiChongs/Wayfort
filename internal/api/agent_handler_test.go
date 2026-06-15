package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/agentgw"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newAdminAgentHandler(t *testing.T) (*AgentHandler, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.GatewayAgent{}, &model.AgentEnrollToken{}, &model.Domain{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return &AgentHandler{
		Agents:   repo.NewGatewayAgentRepo(db),
		Tokens:   repo.NewAgentEnrollTokenRepo(db),
		Domains:  repo.NewDomainRepo(db),
		Registry: agentgw.NewRegistry(),
		Logger:   zap.NewNop(),
	}, db
}

func TestActivate_PendingToOffline(t *testing.T) {
	h, _ := newAdminAgentHandler(t)
	a := &model.GatewayAgent{DomainID: 1, Name: "edge", Status: model.AgentPending}
	if err := h.Agents.Create(t.Context(), a); err != nil {
		t.Fatalf("seed: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/agents/:agentId/activate", h.Activate)
	req := httptest.NewRequest(http.MethodPost, "/agents/1/activate", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	got, _ := h.Agents.FindByID(t.Context(), a.ID)
	if got.Status != model.AgentOffline {
		t.Fatalf("want offline after activate, got %s", got.Status)
	}
	if !got.Schedulable() {
		t.Fatal("activated agent must be schedulable")
	}
}

func TestActivate_RevokedRejected(t *testing.T) {
	h, _ := newAdminAgentHandler(t)
	a := &model.GatewayAgent{DomainID: 1, Name: "edge", Status: model.AgentRevoked}
	if err := h.Agents.Create(t.Context(), a); err != nil {
		t.Fatalf("seed: %v", err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/agents/:agentId/activate", h.Activate)
	req := httptest.NewRequest(http.MethodPost, "/agents/1/activate", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("revoked agent activate must be 400, got %d", w.Code)
	}
}

func TestGenerateEnrollToken_AgentDomainOnly(t *testing.T) {
	h, db := newAdminAgentHandler(t)
	// A proxy domain must be refused; an agent domain must mint a token.
	if err := db.Create(&model.Domain{ID: 1, Name: "proxy-dom", Kind: model.DomainProxy}).Error; err != nil {
		t.Fatalf("seed proxy domain: %v", err)
	}
	if err := db.Create(&model.Domain{ID: 2, Name: "agent-dom", Kind: model.DomainAgent}).Error; err != nil {
		t.Fatalf("seed agent domain: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/domains/:id/agents/enroll-token", h.GenerateEnrollToken)

	// proxy domain → 400
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/domains/1/agents/enroll-token", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("proxy domain token must be 400, got %d", w.Code)
	}

	// agent domain → 201 with a plaintext token whose hash is what we stored
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/domains/2/agents/enroll-token", nil))
	if w.Code != http.StatusCreated {
		t.Fatalf("agent domain token want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var resp enrollTokenOutput
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Token == "" || resp.DomainID != 2 {
		t.Fatalf("unexpected token response %+v", resp)
	}
	// The returned plaintext must be consumable exactly once (proves only the
	// hash was stored and the token wiring is correct end-to-end).
	consumed, err := h.Tokens.Consume(t.Context(), sha256hex(resp.Token), resp.ExpiresAt.Add(-time.Minute))
	if err != nil || consumed == nil || consumed.DomainID != 2 {
		t.Fatalf("returned token should consume for domain 2, got %+v err=%v", consumed, err)
	}
}
