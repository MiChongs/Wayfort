package webssh

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/livewatch"
	"github.com/michongs/wayfort/internal/model"
	"go.uber.org/zap"
)

// HandleObserveTerminal upgrades to a read-only monitoring socket for a live
// terminal session (SSH / Telnet / DB CLI). The observer receives the same
// webssh.v1 TOutput / TResize frames the watched user sees — so the browser
// reuses its normal terminal renderer — but input is never forwarded. A new
// observer is fast-forwarded to the current screen via the hub's scrollback
// baseline. Every watch is audited for compliance.
func (g *Gateway) HandleObserveTerminal(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	sessionID := c.Param("session_id")
	if !g.IsLive(sessionID) {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "会话不在本节点或已结束"})
		return
	}
	conn, err := AcceptWS(c, "webssh.v1")
	if err != nil {
		g.logger.Warn("observe ws upgrade failed", zap.Error(err))
		return
	}
	ob, base, unsub, ok := g.liveHub.Subscribe(sessionID)
	if !ok {
		_ = conn.Close(websocket.StatusNormalClosure, "session ended")
		return
	}
	defer unsub()

	// Compliance: always record who watched what (start + stop), regardless of
	// whether the watched user is notified.
	var nodeID *uint64
	if row, _ := g.sessions.FindByID(c.Request.Context(), sessionID); row != nil {
		nodeID = row.NodeID
	}
	clientIP := c.ClientIP()
	g.audit.Log(model.AuditLog{
		Kind: model.AuditSessionObserve, UserID: claims.UserID, Username: claims.Username,
		SessionID: sessionID, NodeID: nodeID, ClientIP: clientIP, Payload: "start",
	})
	defer g.audit.Log(model.AuditLog{
		Kind: model.AuditSessionObserve, UserID: claims.UserID, Username: claims.Username,
		SessionID: sessionID, NodeID: nodeID, ClientIP: clientIP, Payload: "stop",
	})

	ctx, cancel := context.WithCancel(c.Request.Context())
	defer cancel()
	// Drain (and ignore) any observer input so a client close is detected
	// promptly — the observer is strictly read-only.
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				cancel()
				return
			}
		}
	}()

	writeFrame := func(f Frame) error {
		b, _ := json.Marshal(f)
		wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
		defer wcancel()
		return conn.Write(wctx, websocket.MessageText, b)
	}

	// Fast-forward to the current screen: resize, then replay the scrollback so
	// xterm rebuilds cursor/colours/scroll state from raw bytes.
	if base != nil {
		if base.Cols > 0 && base.Rows > 0 {
			_ = writeFrame(Frame{T: TResize, Cols: base.Cols, Rows: base.Rows})
		}
		if len(base.Scrollback) > 0 {
			_ = writeFrame(Frame{T: TOutput, Data: base64.StdEncoding.EncodeToString(base.Scrollback)})
		}
	}
	_ = writeFrame(Frame{T: TReady})

	for {
		select {
		case <-ctx.Done():
			_ = conn.Close(websocket.StatusNormalClosure, "bye")
			return
		case fr, openCh := <-ob.Frames():
			if !openCh {
				_ = writeFrame(Frame{T: TClose, Msg: "会话已结束"})
				_ = conn.Close(websocket.StatusNormalClosure, "session ended")
				return
			}
			var f Frame
			switch fr.Kind {
			case livewatch.KindOutput:
				f = Frame{T: TOutput, Data: base64.StdEncoding.EncodeToString(fr.Data)}
			case livewatch.KindResize:
				f = Frame{T: TResize, Cols: fr.Cols, Rows: fr.Rows}
			default:
				continue
			}
			if err := writeFrame(f); err != nil {
				return
			}
		}
	}
}
