package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
)

// WSHandler upgrades /api/v1/ws/v2/desktop/:session_id to a WebSocket and
// pipes ServerMessage / ClientMessage frames between browser and worker.
//
// Wire format on the WS hop: one JSON message per WS binary frame. The
// stdio leg (gateway ↔ worker) uses 4-byte length prefixes; the WS leg
// doesn't need to because WebSocket already provides message boundaries.
type WSHandler struct {
	Manager *Manager
	Logger  *zap.Logger
}

func NewWSHandler(m *Manager, logger *zap.Logger) *WSHandler {
	return &WSHandler{Manager: m, Logger: logger}
}

func (h *WSHandler) Handle(c *gin.Context) {
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
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "session not found"})
		return
	}
	if sess.UserID != claims.UserID {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "session owner mismatch"})
		return
	}
	// Reuse webssh's AcceptWS for consistent CORS / subprotocol policy.
	// We use a dedicated subprotocol id so future client-side libs can
	// guard against accidentally connecting to the wrong endpoint.
	conn, err := webssh.AcceptWS(c, "desktop.v1")
	if err != nil {
		h.Logger.Warn("desktop ws upgrade failed", zap.Error(err))
		return
	}
	// 16 MB read limit gives clipboard / large input payloads room.
	conn.SetReadLimit(16 * 1024 * 1024)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	g, gctx := errgroup.WithContext(ctx)

	// browser → worker: read JSON ClientMessages from WS, forward to worker.
	g.Go(func() error {
		for {
			typ, payload, err := conn.Read(gctx)
			if err != nil {
				if gctx.Err() != nil {
					return nil
				}
				if errors.Is(err, io.EOF) {
					return nil
				}
				return err
			}
			if typ != websocket.MessageBinary && typ != websocket.MessageText {
				continue
			}
			var msg ClientMessage
			if err := json.Unmarshal(payload, &msg); err != nil {
				h.Logger.Warn("desktop client msg decode", zap.Error(err))
				continue
			}
			if err := sess.Worker.Send(msg); err != nil {
				h.Logger.Warn("worker send", zap.Error(err))
			}
		}
	})

	// worker → browser: drain worker.Recv() onto WS as JSON binary frames.
	g.Go(func() error {
		for {
			select {
			case <-gctx.Done():
				return nil
			case msg, ok := <-sess.Worker.Recv():
				if !ok {
					return nil
				}
				body, err := json.Marshal(msg)
				if err != nil {
					h.Logger.Warn("desktop server msg encode", zap.Error(err))
					continue
				}
				if err := conn.Write(gctx, websocket.MessageBinary, body); err != nil {
					if gctx.Err() != nil {
						return nil
					}
					return err
				}
				// If worker emits CLOSED or ERROR, tear down the WS.
				if msg.Status != nil && (msg.Status.Phase == PhaseClosed || msg.Status.Phase == PhaseError) {
					return nil
				}
			}
		}
	})

	// Application-level ping every 20s — defends against reverse-proxy idle.
	g.Go(func() error {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-gctx.Done():
				return nil
			case <-t.C:
				pctx, pcancel := context.WithTimeout(gctx, 10*time.Second)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					return err
				}
			}
		}
	})

	werr := g.Wait()
	_ = sess.Worker.Close()
	h.Manager.mu.Lock()
	delete(h.Manager.live, sess.ID)
	h.Manager.mu.Unlock()
	h.Manager.recordEnd(context.Background(), sess, werr)
	if werr != nil {
		h.Logger.Info("desktop session ended", zap.String("session", sess.ID), zap.Error(werr))
		_ = conn.Close(websocket.StatusInternalError, "bye")
		return
	}
	_ = conn.Close(websocket.StatusNormalClosure, "bye")
}
