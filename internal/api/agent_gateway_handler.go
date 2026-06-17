package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/agentgw"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/pki"
	"github.com/michongs/wayfort/internal/repo"
	"go.uber.org/zap"
)

// AgentGatewayHandler serves the reverse-connect agent control plane (the
// agent-facing endpoints, NOT the admin API): one-time enrollment and the WSS
// tunnel. It is the gateway counterpart to cmd/gateway-agent. See
// docs/security-architecture.md §4. M2 authenticates the tunnel with a bearer
// secret; M3 replaces it with mTLS client certificates.
type AgentGatewayHandler struct {
	Agents    *repo.GatewayAgentRepo
	Tokens    *repo.AgentEnrollTokenRepo
	Domains   *repo.DomainRepo
	Registry  *agentgw.Registry
	Logger    *zap.Logger
	GatewayID string // this instance's id, recorded as the tunnel owner (HA)
	// PKI signs agent client certificates. Wired in M3; until the enroll/tunnel
	// paths switch to mTLS it carries the CA so the bundle can be served.
	PKI *pki.Service
}

func sha256hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// AgentRoutes registers the agent control-plane routes on a gin engine. Called
// by main.go for the dedicated mTLS listener — enroll runs with only an OTT (no
// client cert yet), while renew/tunnel require a verified client certificate
// (enforced inside the handlers via peerCert).
func (h *AgentGatewayHandler) AgentRoutes(r *gin.Engine) {
	g := r.Group("/agent/v1")
	g.POST("/enroll", h.Enroll)
	g.POST("/renew", h.Renew)
	g.GET("/tunnel", h.Tunnel)
}

// ipInCIDR reports whether ip falls inside cidr. A malformed cidr or ip is
// treated as a non-match (fail-closed for the optional source pin).
func ipInCIDR(ip, cidr string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return false
	}
	return network.Contains(parsed)
}

func randomSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

type enrollRequest struct {
	Token   string `json:"token"`
	Name    string `json:"name"`
	Version string `json:"version"`
	// CSRPEM is the agent's certificate signing request. The agent keeps the
	// matching private key; the gateway CA signs the CSR into a short-lived
	// client certificate. Required.
	CSRPEM string `json:"csr_pem"`
}

type enrollResponse struct {
	AgentID  uint64 `json:"agent_id"`
	DomainID uint64 `json:"domain_id"`
	// CertPEM is the issued client certificate; CABundle is the trust anchor the
	// agent pins as RootCAs to verify the gateway. The agent stores both.
	CertPEM  string `json:"cert_pem"`
	CABundle string `json:"ca_bundle"`
}

// Enroll consumes a one-time token and registers a new agent in PENDING status,
// signing the agent's CSR into a short-lived client certificate. The agent
// cannot carry sessions until an administrator activates it (status → offline)
// — the defence against an attacker who races a leaked token (§4). Certificate
// auth replaces the M2 bearer secret (§6).
func (h *AgentGatewayHandler) Enroll(c *gin.Context) {
	var req enrollRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Token == "" || req.CSRPEM == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token and csr_pem are required"})
		return
	}
	if h.PKI == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "pki not available"})
		return
	}
	csr, err := pki.ParseCSR([]byte(req.CSRPEM))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid csr"})
		return
	}

	ctx := c.Request.Context()
	tok, err := h.Tokens.Consume(ctx, sha256hex(req.Token), time.Now())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if tok == nil {
		// Unknown / expired / already-used token — uniform 401, no detail.
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired enrollment token"})
		return
	}

	// Optional source-CIDR pin: if the token bound a network, the request must
	// come from it. Belt-and-suspenders against token interception.
	if tok.AllowedCIDR != "" && !ipInCIDR(c.ClientIP(), tok.AllowedCIDR) {
		c.JSON(http.StatusForbidden, gin.H{"error": "enrollment not allowed from this network"})
		return
	}

	name := req.Name
	if name == "" {
		name = "agent"
	}
	agent := &model.GatewayAgent{
		DomainID: tok.DomainID,
		Name:     name,
		Status:   model.AgentPending,
		Version:  req.Version,
		EnrollIP: c.ClientIP(),
	}
	if err := h.Agents.Create(ctx, agent); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Sign the CSR into a client cert bound to this agent id, and record the
	// fingerprint/serial so the tunnel/renew paths can authenticate it.
	issued, err := h.PKI.Issue(ctx, pki.SubjectAgent, agent.ID, name, csr, 0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "certificate issuance failed"})
		return
	}
	agent.Fingerprint = issued.Fingerprint
	agent.CertSerial = issued.Serial
	exp := issued.NotAfter
	agent.CertExpiresAt = &exp
	if err := h.Agents.Update(ctx, agent); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.Logger.Info("agent enrolled (pending activation)",
		zap.Uint64("agent_id", agent.ID), zap.Uint64("domain_id", agent.DomainID),
		zap.String("name", name), zap.String("ip", c.ClientIP()))
	c.JSON(http.StatusCreated, enrollResponse{
		AgentID: agent.ID, DomainID: agent.DomainID,
		CertPEM: string(issued.CertPEM), CABundle: string(h.PKI.Bundle()),
	})
}

// Renew issues a fresh certificate to an already-enrolled agent that
// authenticates with its CURRENT client certificate (mTLS) — no new OTT. The
// old certificate is revoked so a stolen-and-renewed key can't outlive the
// rotation. Fails closed for revoked/pending agents (§4 renew guard).
func (h *AgentGatewayHandler) Renew(c *gin.Context) {
	if h.PKI == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "pki not available"})
		return
	}
	peer := peerCert(c)
	if peer == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "client certificate required"})
		return
	}
	ctx := c.Request.Context()
	agent, ok := h.authAgentByCert(ctx, c, peer)
	if !ok {
		return
	}
	if !agent.Schedulable() {
		c.JSON(http.StatusForbidden, gin.H{"error": "agent not active", "status": string(agent.Status)})
		return
	}

	var body struct {
		CSRPEM string `json:"csr_pem"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.CSRPEM == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "csr_pem required"})
		return
	}
	csr, err := pki.ParseCSR([]byte(body.CSRPEM))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid csr"})
		return
	}
	issued, err := h.PKI.Issue(ctx, pki.SubjectAgent, agent.ID, agent.Name, csr, 0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "certificate issuance failed"})
		return
	}
	// Revoke the old cert, then point the agent at the new one.
	if agent.CertSerial != "" {
		_ = h.PKI.Revoke(ctx, agent.CertSerial, "renewed")
	}
	agent.Fingerprint = issued.Fingerprint
	agent.CertSerial = issued.Serial
	exp := issued.NotAfter
	agent.CertExpiresAt = &exp
	if err := h.Agents.Update(ctx, agent); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Logger.Info("agent certificate renewed",
		zap.Uint64("agent_id", agent.ID), zap.String("ip", c.ClientIP()))
	c.JSON(http.StatusOK, enrollResponse{
		AgentID: agent.ID, DomainID: agent.DomainID,
		CertPEM: string(issued.CertPEM), CABundle: string(h.PKI.Bundle()),
	})
}

// peerCert returns the verified mTLS client certificate, or nil. The 8443
// listener's VerifyClientCertIfGiven guarantees any present cert chains to our
// CA, so callers only re-check revocation + agent status.
func peerCert(c *gin.Context) *x509.Certificate {
	if c.Request.TLS == nil || len(c.Request.TLS.PeerCertificates) == 0 {
		return nil
	}
	return c.Request.TLS.PeerCertificates[0]
}

// authAgentByCert resolves and validates the agent a client cert represents:
// not revoked, fingerprint matches a known agent, and the cert's agent URI
// matches that agent. Writes the error response and returns ok=false on failure.
func (h *AgentGatewayHandler) authAgentByCert(ctx context.Context, c *gin.Context, peer *x509.Certificate) (*model.GatewayAgent, bool) {
	serial := pki.SerialHexOf(peer)
	if revoked, err := h.PKI.IsRevoked(ctx, serial); err != nil || revoked {
		c.JSON(http.StatusForbidden, gin.H{"error": "certificate revoked"})
		return nil, false
	}
	fp := certFingerprint(peer)
	agent, err := h.Agents.FindByFingerprint(ctx, fp)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return nil, false
	}
	if agent == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unknown agent certificate"})
		return nil, false
	}
	// Cross-check the cert's agent URI SAN against the row resolved by fingerprint.
	if id, err := pki.AgentIDFromCert(peer); err != nil || id != agent.ID {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "certificate identity mismatch"})
		return nil, false
	}
	return agent, true
}

// certFingerprint is the SHA-256 hex of the certificate DER — matches
// pki.IssuedCert.Fingerprint and model.GatewayAgent.Fingerprint.
func certFingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:])
}

// heartbeatStats returns a small JSON blob of the tunnel's live load for the
// agent row, so the UI can show active streams + RTT.
func (h *AgentGatewayHandler) heartbeatStats(tun *agentgw.Tunnel) string {
	stats := map[string]any{"streams": tun.NumStreams()}
	if rtt, err := tun.Ping(); err == nil {
		stats["rtt_ms"] = rtt.Milliseconds()
	}
	b, _ := json.Marshal(stats)
	return string(b)
}

// runHeartbeat refreshes the agent row every 30s until the tunnel ends.
func (h *AgentGatewayHandler) runHeartbeat(ctx context.Context, tun *agentgw.Tunnel, agentID uint64) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	done := make(chan struct{})
	go func() { tun.Wait(); close(done) }()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			hbCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = h.Agents.Touch(hbCtx, agentID, h.GatewayID, h.heartbeatStats(tun), time.Now())
			cancel()
		}
	}
}

// Tunnel upgrades to WebSocket, authenticates the agent by its mTLS client
// certificate, and runs the yamux tunnel for the connection's lifetime,
// registering it so agent-domain dials can route through it.
func (h *AgentGatewayHandler) Tunnel(c *gin.Context) {
	peer := peerCert(c)
	if peer == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "client certificate required"})
		return
	}
	if h.PKI == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "pki not available"})
		return
	}
	ctx := c.Request.Context()
	agent, ok := h.authAgentByCert(ctx, c, peer)
	if !ok {
		return
	}
	if !agent.Schedulable() {
		// pending (not yet activated) or revoked.
		c.JSON(http.StatusForbidden, gin.H{
			"error": "agent not active", "status": string(agent.Status),
		})
		return
	}

	wsConn, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return // Accept already wrote the error
	}
	wsConn.SetReadLimit(-1)
	// A background ctx so the tunnel outlives the HTTP handler's request ctx
	// (which the WS upgrade would otherwise cancel).
	tunCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	netConn := websocket.NetConn(tunCtx, wsConn, websocket.MessageBinary)

	tun, err := agentgw.NewGatewayTunnel(agent.ID, agent.DomainID, netConn)
	if err != nil {
		_ = wsConn.Close(websocket.StatusInternalError, "tunnel setup failed")
		return
	}
	h.Registry.Register(tun)
	_ = h.Agents.Touch(ctx, agent.ID, h.GatewayID, h.heartbeatStats(tun), time.Now())
	h.Logger.Info("agent tunnel up",
		zap.Uint64("agent_id", agent.ID), zap.Uint64("domain_id", agent.DomainID))

	// Heartbeat loop: refresh last_seen + live stats every 30s so the stale
	// reaper can tell a healthy long-lived tunnel from a crashed one, until the
	// agent disconnects or the session drops.
	h.runHeartbeat(tunCtx, tun, agent.ID)

	h.Registry.Unregister(agent.ID)
	_ = tun.Close()
	_ = wsConn.Close(websocket.StatusNormalClosure, "bye")
	// Best-effort mark offline (a fresh ctx — the request ctx is gone).
	offCtx, offCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = h.Agents.UpdateStatus(offCtx, agent.ID, model.AgentOffline)
	offCancel()
	h.Logger.Info("agent tunnel down", zap.Uint64("agent_id", agent.ID))
}
