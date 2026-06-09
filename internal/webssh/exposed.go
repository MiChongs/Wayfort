package webssh

import (
	"context"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/cache"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
	"golang.org/x/net/proxy"
)

// AcceptWS upgrades a gin request to a WebSocket with the gateway's standard options.
func AcceptWS(c *gin.Context, subprotocols ...string) (*websocket.Conn, error) {
	if len(subprotocols) == 0 {
		subprotocols = []string{"webssh.v1"}
	}
	return websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{
		OriginPatterns:  []string{"*"},
		Subprotocols:    subprotocols,
		CompressionMode: websocket.CompressionDisabled,
	})
}

// Exposed accessors used by sibling protocol packages so they can reuse the
// gateway's bookkeeping (audit, session rows, proxy chain) without duplicating
// dependency wiring.
func (g *Gateway) Logger() *zap.Logger                   { return g.logger }
func (g *Gateway) Audit() *audit.Writer                  { return g.audit }
func (g *Gateway) Sessions() *repo.SessionRepo           { return g.sessions }
func (g *Gateway) Cache() *cache.Cache                   { return g.cache }
func (g *Gateway) WSConfig() config.WebSSHConfig         { return g.cfg }
func (g *Gateway) RecorderConfig() config.RecorderConfig { return g.recorder }
func (g *Gateway) Storage() string                       { return g.storage }
func (g *Gateway) NodeRepo() *repo.NodeRepo              { return g.nodes }
func (g *Gateway) CredentialRepo() *repo.CredentialRepo  { return g.creds }
func (g *Gateway) ProxyRepo() *repo.ProxyRepo            { return g.proxies }
func (g *Gateway) Chain() *dialer.ChainBuilder           { return g.chain }

// ResolveHops parses Node.ProxyChain ("1,3,7") into ordered Proxy rows.
func (g *Gateway) ResolveHops(ctx context.Context, chain string) ([]*model.Proxy, error) {
	return g.resolveHops(ctx, chain)
}

// BuildChain composes a ContextDialer that walks the supplied hops.
func (g *Gateway) BuildChain(ctx context.Context, hops []*model.Proxy) (proxy.ContextDialer, func(), error) {
	return g.chain.Build(ctx, hops, nil)
}

// BeginSession writes the start row, registers the session in Redis, and emits
// the start audit event. The returned row should be passed unchanged to EndSession.
func (g *Gateway) BeginSession(ctx context.Context, sessionID string, kind model.SessionKind, claims *auth.Claims, clientIP string, node *model.Node, recPath string, recType model.RecordingType) *model.Session {
	row := &model.Session{
		ID:            sessionID,
		Kind:          kind,
		UserID:        claims.UserID,
		Username:      claims.Username,
		ClientIP:      clientIP,
		StartedAt:     nowFunc(),
		Status:        model.SessionActive,
		RecordingPath: recPath,
		RecordingType: recType,
	}
	if node != nil {
		nodeID := node.ID
		row.NodeID = &nodeID
		row.NodeName = node.Name
	}
	if err := g.sessions.Create(ctx, row); err != nil {
		g.logger.Warn("session row create failed", zap.Error(err))
	}
	if g.cache != nil {
		_ = g.cache.RegisterSession(ctx, sessionID, claims.Username)
	}
	g.audit.Log(model.AuditLog{
		Kind:      model.AuditSessionStart,
		UserID:    claims.UserID,
		Username:  claims.Username,
		SessionID: sessionID,
		NodeID:    row.NodeID,
		ClientIP:  clientIP,
	})
	// Sibling protocols (dbcli / telnet / guacamole) call BeginSession only
	// after the connection is established, so the session is ready here. Open a
	// ready phase; EndSession's finalize closes it. Protocols that want the full
	// dial/auth/handshake breakdown can call OpenPhase around their connect.
	_ = g.OpenPhase(sessionID, model.PhaseReady, claims, clientIP, row.NodeID)
	return row
}

// CommandAuditor returns an OnCommand callback that reconstructs whole command
// lines from the keystroke stream and writes one audit row per command. Sibling
// protocol packages (dbcli, telnet) pass the result to Session.OnCommand so DB
// CLI / Telnet input is audited the same way SSH is.
func (g *Gateway) CommandAuditor(sessionID string, claims *auth.Claims, clientIP string, node *model.Node) func(string) {
	var nodeID *uint64
	if node != nil {
		id := node.ID
		nodeID = &id
	}
	tracker := newCmdTracker(func(cmd string) {
		g.audit.Log(model.AuditLog{
			Kind: model.AuditCommand, UserID: claims.UserID, Username: claims.Username,
			SessionID: sessionID, NodeID: nodeID, ClientIP: clientIP, Payload: cmd,
		})
	})
	return tracker.feed
}

// RegisterLive binds a session id to the cancel func that tears its run loop
// down, so an admin can force the session off from the audit page. The returned
// func unregisters it; call it after EndSession so the teardown can still read
// the terminated flag. Sibling protocol packages (telnet, dbcli, guacamole)
// reuse this to get force-off support without their own registry.
func (g *Gateway) RegisterLive(sessionID string, cancel context.CancelFunc) func() {
	g.registerLive(sessionID, cancel)
	return func() { g.unregisterLive(sessionID) }
}

// WasTerminated reports whether TerminateSession was invoked against a session
// that is still registered as live.
func (g *Gateway) WasTerminated(sessionID string) bool {
	g.liveMu.Lock()
	ls, ok := g.live[sessionID]
	g.liveMu.Unlock()
	return ok && ls.terminated.Load()
}

// EndSession finalises a session row with byte counters and the terminal
// error (if any), unregisters from Redis, and emits the end audit event.
func (g *Gateway) EndSession(ctx context.Context, row *model.Session, claims *auth.Claims, bytesIn, bytesOut uint64, runErr error) {
	end := nowFunc()
	row.EndedAt = &end
	row.BytesIn = bytesIn
	row.BytesOut = bytesOut
	switch {
	case g.WasTerminated(row.ID):
		row.Status = model.SessionTerminated
		row.Reason = "管理员强制下线"
	case runErr != nil:
		row.Status = model.SessionErrored
		row.Reason = truncate(runErr.Error(), 250)
	default:
		row.Status = model.SessionClosed
	}
	// Backfill phase + quality rollups, then persist the end fields with a
	// partial update (mirrors the SSH main path's recordEnd).
	g.finalizeLifecycle(row)
	if err := g.sessions.Finish(ctx, row.ID, map[string]any{
		"ended_at":        end,
		"bytes_in":        row.BytesIn,
		"bytes_out":       row.BytesOut,
		"status":          row.Status,
		"reason":          row.Reason,
		"current_phase":   row.CurrentPhase,
		"peak_rtt_ms":     row.PeakRTTMs,
		"avg_rtt_ms":      row.AvgRTTMs,
		"reconnect_count": row.ReconnectCount,
	}); err != nil {
		g.logger.Warn("session row finish failed", zap.Error(err))
	}
	if g.cache != nil {
		_ = g.cache.UnregisterSession(ctx, row.ID)
	}
	g.audit.Log(model.AuditLog{
		Kind:      model.AuditSessionEnd,
		UserID:    claims.UserID,
		Username:  claims.Username,
		SessionID: row.ID,
		NodeID:    row.NodeID,
		ClientIP:  row.ClientIP,
	})
}
