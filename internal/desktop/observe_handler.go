package desktop

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/livewatch"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	"go.uber.org/zap"
)

// HandleObserve upgrades to a read-only monitoring socket for a live desktop
// session. The observer receives the same desktop.v2 binary frames the watched
// user sees (so the browser reuses its canvas renderer); it sends nothing to the
// worker except a one-shot full-screen refresh on join, so its canvas paints
// immediately instead of waiting for the next natural keyframe. WebRTC-video
// sessions are not monitorable (frames go to a Pion track, not the WS).
func (h *WSHandler) HandleObserve(c *gin.Context) {
	if h.Manager == nil || !h.Manager.Enabled() {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "desktop subsystem disabled"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	sessionID := c.Param("session_id")
	sess := h.Manager.Take(sessionID)
	if sess == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "会话不在本节点或已结束"})
		return
	}
	if isWebRTCVideoMode(sess.VideoMode) {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "该会话使用 WebRTC 视频，暂不支持实时监看"})
		return
	}
	hub := h.Manager.LiveHub()
	if hub == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "monitoring disabled"})
		return
	}
	conn, err := webssh.AcceptWS(c, "desktop.v2")
	if err != nil {
		h.Logger.Warn("desktop observe ws upgrade failed", zap.Error(err))
		return
	}
	conn.SetReadLimit(1 << 20)

	ob, _, unsub, ok := hub.Subscribe(sessionID)
	if !ok {
		_ = conn.Close(websocket.StatusNormalClosure, "session ended")
		return
	}
	defer unsub()

	// Compliance: always record who watched what (start + stop).
	nodeID := sess.nodeIDPtr()
	clientIP := c.ClientIP()
	h.Manager.audit.Log(model.AuditLog{
		Kind: model.AuditSessionObserve, UserID: claims.UserID, Username: claims.Username,
		SessionID: sessionID, NodeID: nodeID, ClientIP: clientIP, Payload: "start",
	})
	defer h.Manager.audit.Log(model.AuditLog{
		Kind: model.AuditSessionObserve, UserID: claims.UserID, Username: claims.Username,
		SessionID: sessionID, NodeID: nodeID, ClientIP: clientIP, Payload: "stop",
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Detect observer disconnect (read-only — input is ignored).
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				cancel()
				return
			}
		}
	}()

	// One-shot full repaint so the new observer's canvas fills immediately.
	if sess.Worker != nil {
		_ = sess.Worker.Send(ClientMessage{Refresh: &RefreshRect{}})
	}

	for {
		select {
		case <-ctx.Done():
			_ = conn.Close(websocket.StatusNormalClosure, "bye")
			return
		case fr, openCh := <-ob.Frames():
			if !openCh {
				_ = conn.Close(websocket.StatusNormalClosure, "session ended")
				return
			}
			if fr.Kind != livewatch.KindOutput {
				continue
			}
			wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
			werr := conn.Write(wctx, websocket.MessageBinary, fr.Data)
			wcancel()
			if werr != nil {
				return
			}
		}
	}
}
