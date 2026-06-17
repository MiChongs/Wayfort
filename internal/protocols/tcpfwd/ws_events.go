package tcpfwd

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/webssh"
)

// WSEvents streams port-forward lifecycle + throughput events to a browser
// over a long-lived WebSocket. The browser uses this to drive the live
// per-row byte-rate counters, sparklines, and the activity monitor inside
// the workspace tab — replacing what used to be a polling loop.
type WSEvents struct {
	Manager *Manager
}

// clientHeartbeat mirrors the desktop WS heartbeat protocol: the browser
// sends `{ts_ms}` periodically and the server echoes the same timestamp
// back so the frontend can compute round-trip latency.
type clientHeartbeat struct {
	TSMs int64 `json:"ts_ms"`
}

type serverHeartbeat struct {
	Type string `json:"type"`
	TSMs int64  `json:"ts_ms"`
}

// Handle upgrades the request to a WebSocket and runs the read/write pumps
// until the client disconnects. Each subscriber receives events scoped to
// its own user_id (admins still only see their own forwarders here — the
// admin "see everyone" view is the REST list endpoint).
func (h *WSEvents) Handle(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	if h.Manager == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "tcpfwd disabled"})
		return
	}
	ws, err := webssh.AcceptWS(c, "portfwd-events.v1")
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sub, unsub := h.Manager.Bus().Subscribe(claims.UserID)
	defer unsub()

	// Read pump: forward heartbeats and let `ws.Read` cancel us when the
	// browser disconnects. We deliberately don't accept any subscribe /
	// filter frames yet — the user_id-scoped subscription is implicit.
	go func() {
		for {
			typ, data, rerr := ws.Read(ctx)
			if rerr != nil {
				cancel()
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			var hb struct {
				HB *clientHeartbeat `json:"hb,omitempty"`
			}
			if json.Unmarshal(data, &hb) != nil {
				continue
			}
			if hb.HB != nil {
				echo := serverHeartbeat{Type: "hb", TSMs: hb.HB.TSMs}
				out, _ := json.Marshal(echo)
				if werr := ws.Write(ctx, websocket.MessageText, out); werr != nil {
					cancel()
					return
				}
			}
		}
	}()

	// Write pump: drain subscriber until the read pump or ctx cancels.
	// `writeDeadline` keeps us from blocking forever on a stuck network —
	// drop the connection at that point so the bus does not back-pressure.
	for {
		select {
		case <-ctx.Done():
			_ = ws.Close(websocket.StatusNormalClosure, "bye")
			return
		case ev, ok := <-sub.Events():
			if !ok {
				_ = ws.Close(websocket.StatusNormalClosure, "bus closed")
				return
			}
			payload, mErr := json.Marshal(ev)
			if mErr != nil {
				continue
			}
			wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
			werr := ws.Write(wctx, websocket.MessageText, payload)
			wcancel()
			if werr != nil {
				_ = ws.Close(websocket.StatusInternalError, "write failed")
				return
			}
		}
	}
}
