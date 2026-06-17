package webssh

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/michongs/wayfort/internal/approval"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/protocols/telnet"
	"go.uber.org/zap"
)

// HandleNodeTelnet brokers a WebSocket terminal that talks raw Telnet to the
// target. Network devices commonly only expose Telnet; we treat IAC negotiation
// as pass-through and let xterm.js render the resulting stream.
func (g *Gateway) HandleNodeTelnet(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	nodeID, err := strconv.ParseUint(c.Param("node_id"), 10, 64)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return
	}
	node, err := g.nodes.FindByID(c.Request.Context(), nodeID)
	if err != nil || node == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	if node.Disabled || node.EffectiveProtocol() != model.NodeProtoTelnet {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "node is not a telnet target"})
		return
	}

	// Phase 16 — same approval gate as the SSH handler.
	if g.approval != nil {
		res, err := g.approval.CheckEnforced(c.Request.Context(), approval.EnforcementCheck{
			UserID:       claims.UserID,
			BusinessType: model.ApprovalBizAssetAccess,
			ResourceType: "node",
			ResourceID:   strconv.FormatUint(nodeID, 10),
			Action:       "connect",
		})
		if err != nil {
			g.logger.Warn("approval check error", zap.Error(err), zap.Uint64("node_id", nodeID))
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "approval check failed"})
			return
		}
		if !res.Allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": res.Reason, "approval_required": true})
			return
		}
	}

	cols := atoiDefault(c.Query("cols"), 120)
	rows := atoiDefault(c.Query("rows"), 32)

	// Overload guard — reserve a slot before opening the socket (note: telnet is
	// plaintext, so an agent domain's whitelist may refuse it here).
	release, gerr := g.Admit(c.Request.Context(), claims.UserID, node)
	if gerr != nil {
		status, code, msg := guardRejectHTTP(gerr)
		c.AbortWithStatusJSON(status, gin.H{"error": msg, "code": code})
		return
	}
	defer release()

	conn, err := AcceptWS(c, "webssh.v1")
	if err != nil {
		g.logger.Warn("ws upgrade failed", zap.Error(err))
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sessionID := uuid.NewString()
	clientIP := c.ClientIP()
	if err := g.runTelnetSession(ctx, conn, sessionID, claims, clientIP, node, cols, rows); err != nil {
		g.logger.Info("telnet session ended", zap.String("session", sessionID), zap.Error(err))
		code, reason := closeForError(err)
		_ = conn.Close(code, reason)
		return
	}
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
}

func (g *Gateway) runTelnetSession(ctx context.Context, conn *websocket.Conn, sessionID string, claims *auth.Claims, clientIP string, node *model.Node, cols, rows int) error {
	finalDialer, _, release, err := g.DialerForNode(ctx, node, sessionID)
	if err != nil {
		return fmt.Errorf("resolve dialer: %w", err)
	}
	defer release()
	port := node.Port
	if port == 0 {
		port = 23
	}
	backend, err := telnet.Dial(ctx, finalDialer, node.Host, port)
	if err != nil {
		return err
	}

	rec, rerr := audit.NewRecorder(sessionID, g.storage, g.recorder, cols, rows, g.logger)
	if rerr != nil {
		g.logger.Warn("recorder init failed", zap.Error(rerr))
	}
	recPath := ""
	recType := model.RecordingNone
	if rec != nil {
		recPath = rec.Path()
		recType = model.RecordingAsciicast
	}
	row := g.BeginSession(context.Background(), sessionID, model.SessionInteractive, claims, clientIP, node, recPath, recType)

	sess := &Session{ID: sessionID, Conn: conn, Backend: backend, Recorder: rec, Cfg: g.cfg, Logger: g.logger, LiveHub: g.liveHub}
	nodeID := node.ID
	tracker := newCmdTracker(func(cmd string) {
		g.Audit().Log(model.AuditLog{
			Kind: model.AuditCommand, UserID: claims.UserID, Username: claims.Username,
			SessionID: sessionID, NodeID: &nodeID, ClientIP: clientIP, Payload: cmd,
		})
		g.applyCommandRules(ctx, sess, claims.UserID, nodeID, clientIP, sessionID, claims.Username, cmd)
	})
	sess.OnCommand(tracker.feed)

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	unreg := g.RegisterLive(sessionID, cancel)
	defer unreg()

	// Sample connection quality + persist live byte totals (client RTT only —
	// telnet has no SSH keepalive hop).
	if sink := g.MetricSink(sessionID); sink != nil {
		sess.OnLatency = sink.ObserveLatency
		go sink.Run(sctx, 5*time.Second, func() (uint64, uint64) {
			return sess.BytesIn.Load(), sess.BytesOut.Load()
		})
	}

	runErr := sess.Run(sctx)
	endErr := runErr
	if errors.Is(endErr, context.Canceled) {
		endErr = nil
	}
	g.EndSession(context.Background(), row, claims, sess.BytesIn.Load(), sess.BytesOut.Load(), endErr)
	return runErr
}
