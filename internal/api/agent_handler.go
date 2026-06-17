package api

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/agentgw"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/pki"
	"github.com/michongs/wayfort/internal/repo"
	"go.uber.org/zap"
)

// AgentHandler is the ADMIN control plane for reverse-connect Gateway Agents
// (security-architecture.md §4): list agents, mint one-time enrollment tokens,
// and run the lifecycle (activate / revoke / delete). All endpoints require the
// agent:manage permission. The agent-FACING enroll/tunnel endpoints live in
// AgentGatewayHandler.
type AgentHandler struct {
	Agents   *repo.GatewayAgentRepo
	Tokens   *repo.AgentEnrollTokenRepo
	Domains  *repo.DomainRepo
	Registry *agentgw.Registry
	PKI      *pki.Service
	Audit    *audit.Writer // high-sensitivity lifecycle events (nil-safe)
	Logger   *zap.Logger

	// Agent面 connectivity, surfaced to the admin UI via Info so it can compose
	// the exact install command and warn when the mTLS listener is disabled
	// (it defaults off — §4/§14). Set from cfg.Agent.
	ListenerEnabled bool
	PublicHost      string
	AgentAddr       string
	DistDir         string
}

// critical emits an agent-lifecycle event on the audit writer's blocking
// critical path so a command flood can't suppress it. Best-effort: the admin
// action already committed, so a full critical queue is logged, not rolled back.
func (h *AgentHandler) critical(c *gin.Context, kind model.AuditEventKind, agentID uint64, detail string) {
	if h.Audit == nil {
		return
	}
	var uid uint64
	var uname string
	if claims := auth.FromContext(c.Request.Context()); claims != nil {
		uid, uname = claims.UserID, claims.Username
	}
	// agent id goes in the payload (not NodeID, which the audit center resolves
	// to an asset name). agentID 0 = an agent-less event (e.g. token issuance).
	payload := detail
	if agentID != 0 {
		payload = fmt.Sprintf("agent=%d %s", agentID, detail)
	}
	_ = h.Audit.LogCritical(c.Request.Context(), model.AuditLog{
		Kind: kind, UserID: uid, Username: uname,
		ClientIP: c.ClientIP(), Payload: payload,
	})
}

// agentView decorates a stored agent with live registry status so the UI shows
// whether the agent is actually connected to this gateway right now.
type agentView struct {
	model.GatewayAgent
	Connected bool `json:"connected"`
}

// List returns the agents registered under a domain, decorated with live status.
func (h *AgentHandler) List(c *gin.Context) {
	domainID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的网域 id"})
		return
	}
	rows, err := h.Agents.ListByDomain(c.Request.Context(), domainID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]agentView, 0, len(rows))
	for i := range rows {
		out = append(out, agentView{GatewayAgent: rows[i], Connected: h.Registry.Has(rows[i].ID)})
	}
	c.JSON(http.StatusOK, gin.H{"agents": out})
}

// agentGatewayInfo tells the admin UI whether the agent面 is live and how to
// build the install command, so an operator isn't left guessing why a freshly
// enrolled agent never connects (the mTLS listener defaults off — §4/§14).
type agentGatewayInfo struct {
	Enabled     bool   `json:"enabled"`      // is the mTLS listener actually up?
	Server      string `json:"server"`       // wss://host:port the agent dials
	ScriptPath  string `json:"script_path"`  // origin-relative installer path
	BinaryReady bool   `json:"binary_ready"` // is a binary staged for download?
}

// Info reports the reverse-connect agent面 status for the console: whether the
// listener is enabled, the --server URL agents should dial, and whether a binary
// is staged to download. Lets the UI surface a loud "listener disabled" warning
// and a copy-paste install command instead of failing silently.
func (h *AgentHandler) Info(c *gin.Context) {
	ready := false
	if h.DistDir != "" {
		if _, err := os.Stat(filepath.Join(h.DistDir, "gateway-agent-linux-amd64")); err == nil {
			ready = true
		}
	}
	c.JSON(http.StatusOK, agentGatewayInfo{
		Enabled:     h.ListenerEnabled,
		Server:      agentServerURL(h.PublicHost, h.AgentAddr, c.Request.Host),
		ScriptPath:  "/dl/gateway-agent.sh",
		BinaryReady: ready,
	})
}

type enrollTokenInput struct {
	// AllowedCIDR optionally pins which source network may consume the token.
	AllowedCIDR string `json:"allowed_cidr"`
	// TTLMinutes overrides the default 15-minute lifetime (1..120).
	TTLMinutes int `json:"ttl_minutes"`
}

type enrollTokenOutput struct {
	Token     string    `json:"token"` // shown exactly once
	ExpiresAt time.Time `json:"expires_at"`
	DomainID  uint64    `json:"domain_id"`
}

// GenerateEnrollToken mints a one-time enrollment token for an agent domain.
// Only the hash is stored; the plaintext is returned exactly once for the admin
// to paste into the agent's enroll command.
func (h *AgentHandler) GenerateEnrollToken(c *gin.Context) {
	domainID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的网域 id"})
		return
	}
	dom, err := h.Domains.FindByID(c.Request.Context(), domainID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if dom == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "网域不存在"})
		return
	}
	if dom.Kind != model.DomainAgent {
		c.JSON(http.StatusBadRequest, gin.H{"error": "仅 Agent 域可签发注册令牌"})
		return
	}

	var in enrollTokenInput
	_ = c.ShouldBindJSON(&in) // body optional
	ttl := 15
	if in.TTLMinutes >= 1 && in.TTLMinutes <= 120 {
		ttl = in.TTLMinutes
	}

	token, err := randomSecret()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "令牌生成失败"})
		return
	}
	expires := time.Now().Add(time.Duration(ttl) * time.Minute)
	var createdBy uint64
	if claims := auth.FromContext(c.Request.Context()); claims != nil {
		createdBy = claims.UserID
	}
	row := &model.AgentEnrollToken{
		DomainID:    domainID,
		TokenHash:   sha256hex(token),
		AllowedCIDR: strings.TrimSpace(in.AllowedCIDR),
		CreatedBy:   createdBy,
		ExpiresAt:   expires,
	}
	if err := h.Tokens.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Logger.Info("agent enroll token issued",
		zap.Uint64("domain_id", domainID), zap.Uint64("by", createdBy), zap.Time("expires", expires))
	h.critical(c, model.AuditAgentEnrollToken, 0, fmt.Sprintf("issued enroll token for domain %d (ttl %dm)", domainID, ttl))
	c.JSON(http.StatusCreated, enrollTokenOutput{Token: token, ExpiresAt: expires, DomainID: domainID})
}

// Activate flips a pending agent to offline so it may connect. This is the
// human-in-the-loop check against a raced enrollment token (§4): an admin
// verifies the agent's identity before it can ever carry a session.
func (h *AgentHandler) Activate(c *gin.Context) {
	agent, ok := h.load(c)
	if !ok {
		return
	}
	if agent.Status == model.AgentRevoked {
		c.JSON(http.StatusBadRequest, gin.H{"error": "已吊销的 Agent 不能激活"})
		return
	}
	if agent.Status == model.AgentPending {
		if err := h.Agents.UpdateStatus(c.Request.Context(), agent.ID, model.AgentOffline); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		h.Logger.Info("agent activated", zap.Uint64("agent_id", agent.ID))
		h.critical(c, model.AuditAgentActivate, agent.ID, "activated "+agent.Name)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": model.AgentOffline})
}

// Revoke disables an agent and tears down any live tunnel.
func (h *AgentHandler) Revoke(c *gin.Context) {
	agent, ok := h.load(c)
	if !ok {
		return
	}
	if err := h.Agents.UpdateStatus(c.Request.Context(), agent.ID, model.AgentRevoked); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Registry.Disconnect(agent.ID)
	// Cert-level revocation in addition to the status gate: a stolen key can't
	// renew its way back to life once every cert the agent held is on the CRL.
	if h.PKI != nil {
		_ = h.PKI.RevokeSubject(c.Request.Context(), pki.SubjectAgent, agent.ID, "agent revoked")
	}
	h.Logger.Info("agent revoked", zap.Uint64("agent_id", agent.ID))
	h.critical(c, model.AuditAgentRevoke, agent.ID, "revoked "+agent.Name)
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": model.AgentRevoked})
}

// Delete removes an agent, tearing down any live tunnel first.
func (h *AgentHandler) Delete(c *gin.Context) {
	agent, ok := h.load(c)
	if !ok {
		return
	}
	h.Registry.Disconnect(agent.ID)
	if h.PKI != nil {
		_ = h.PKI.RevokeSubject(c.Request.Context(), pki.SubjectAgent, agent.ID, "agent deleted")
	}
	if err := h.Agents.Delete(c.Request.Context(), agent.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.critical(c, model.AuditAgentDelete, agent.ID, "deleted "+agent.Name)
	c.Status(http.StatusNoContent)
}

// load fetches the :agentId path agent or writes the error response.
func (h *AgentHandler) load(c *gin.Context) (*model.GatewayAgent, bool) {
	id, err := strconv.ParseUint(c.Param("agentId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 agent id"})
		return nil, false
	}
	agent, err := h.Agents.FindByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return nil, false
	}
	if agent == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Agent 不存在"})
		return nil, false
	}
	return agent, true
}
