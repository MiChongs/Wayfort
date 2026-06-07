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
// Wire format on the WS hop:
//   - desktop.v1: one JSON message per WS binary frame.
//   - desktop.v2: binary header + payload for frame/cursor payloads, and a
//     binary JSON envelope for status / clipboard / bell.
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
	// Single-WS-per-session: a duplicated tab or a reconnect racing the old
	// socket's teardown must not attach a second reader to the one
	// Worker.Recv() channel (frames would split between the two and both
	// canvases garble). Claim the session for this WS and release on exit.
	if !sess.ClaimForWS() {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "session already has an active connection"})
		return
	}
	defer sess.ReleaseWS()
	// Reuse webssh's AcceptWS for consistent CORS / subprotocol policy.
	// We use a dedicated subprotocol id so future client-side libs can
	// guard against accidentally connecting to the wrong endpoint.
	conn, err := webssh.AcceptWS(c, "desktop.v2", "desktop.v1")
	if err != nil {
		h.Logger.Warn("desktop ws upgrade failed", zap.Error(err))
		return
	}
	useBinaryV2 := conn.Subprotocol() == "desktop.v2"
	// 16 MB read limit gives clipboard / large input payloads room.
	conn.SetReadLimit(16 * 1024 * 1024)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	g, gctx := errgroup.WithContext(ctx)

	// Heartbeat-ack lane. The browser→worker reader pushes a pong here; the
	// worker→browser writer drains it onto the socket. coder/websocket forbids
	// concurrent writers, so the reader can't echo directly — it hands off the
	// ack to the single goroutine that owns conn.Write.
	pongCh := make(chan ServerMessage, 4)

	// WebRTC video path: when the manager started this session in VP8 video
	// mode, stand up a per-session Pion bridge. The worker's Video messages go
	// to its track (not the WS); the browser's offer / ICE candidates are
	// answered here. nil bridge = legacy bitmap path (video rides the WS).
	var bridge *webrtcBridge
	if isWebRTCVideoMode(sess.VideoMode) && h.Manager.WebRTCConfig().Enabled {
		bridge = newWebRTCBridge(h.Manager.WebRTCConfig(), h.Logger, sess.VideoMode, sess.VideoBitrateKbps,
			func() { _ = sess.Worker.Send(ClientMessage{RequestKeyframe: true}) },
			func(kbps int) { _ = sess.Worker.Send(ClientMessage{SetBitrateKbps: kbps}) },
		)
		defer bridge.Close()
	}

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
			// Heartbeat → echo straight back so the browser can clock the
			// round-trip. The worker treats heartbeats as noise (input.go), so
			// we answer here and don't forward — the ack rides pongCh to the
			// one goroutine allowed to write the socket. A full lane just drops
			// this sample; the next heartbeat (≈2s) measures fine.
			if msg.HB != nil {
				select {
				case pongCh <- ServerMessage{HB: &Heartbeat{TSMs: msg.HB.TSMs}}:
				case <-gctx.Done():
					return nil
				default:
				}
				continue
			}
			// WebRTC signaling (offer / ICE) terminates at the gateway bridge —
			// it never reaches the worker. Everything else (input, clipboard,
			// resize, and the VideoMode "bitmap" fallback switch) forwards on.
			if msg.WebRTC != nil {
				if bridge != nil {
					bridge.HandleSignal(msg.WebRTC)
				}
				continue
			}
			if err := sess.Worker.Send(msg); err != nil {
				h.Logger.Warn("worker send", zap.Error(err))
			}
			// Audit: tee inbound input (key / mouse / clipboard) onto the tape.
			// nil-safe and filters heartbeats/caps internally.
			sess.recorder.WriteInput(msg)
		}
	})

	// worker → browser: drain worker.Recv() onto WS.
	g.Go(func() error {
		workerRecv := sess.Worker.Recv()
		// nil channel when there's no bridge — select never picks it.
		var bridgeSignals <-chan ServerMessage
		if bridge != nil {
			bridgeSignals = bridge.Signals()
		}
		pending := make([]ServerMessage, 0, 4)
		var lastPhase Phase // de-dups recorded status events (stats spam reuses CONNECTED)
		for {
			var msg ServerMessage
			if len(pending) > 0 {
				msg = pending[0]
				copy(pending, pending[1:])
				pending = pending[:len(pending)-1]
			} else {
				select {
				case <-gctx.Done():
					return nil
				case pong := <-pongCh:
					msg = pong // heartbeat-ack → WS (latency probe)
				case sig := <-bridgeSignals:
					msg = sig // gateway SDP answer / ICE candidate → WS
				case next, ok := <-workerRecv:
					if !ok {
						return nil
					}
					msg = next
				}
			}
			// WebRTC video: hand the worker's VP8 access units to the Pion
			// track, never to the WS. (Also catches a Video that coalesce
			// parked in `pending`.)
			if msg.Video != nil {
				if bridge != nil {
					bridge.WriteVideo(msg.Video)
				}
				continue
			}
			msg = coalesceFrameMessages(msg, workerRecv, &pending)
			select {
			case <-gctx.Done():
				return nil
			default:
				body, err := encodeServerMessageForWS(msg, useBinaryV2)
				if err != nil {
					h.Logger.Warn("desktop server msg encode", zap.Error(err))
					continue
				}
				// Audit: tee onto the recording tape (nil-safe).
				recordServerMessage(sess.recorder, msg, body, useBinaryV2, &lastPhase)
				// Bound each write. coder/websocket has no built-in write
				// deadline; without one a browser with a stuck TCP receive
				// window blocks this goroutine indefinitely, the worker's out
				// channel fills, and the worker silently drops frames AND
				// terminal status. A timeout turns that into a clean teardown.
				wctx, wcancel := context.WithTimeout(gctx, 10*time.Second)
				err = conn.Write(wctx, websocket.MessageBinary, body)
				wcancel()
				if err != nil {
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
	if sess.socksClose != nil {
		sess.socksClose()
	}
	if sess.recorder != nil {
		sess.recorder.WriteEvent(RecordingEvent{Type: "session-end"})
		_ = sess.recorder.Close()
	}
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

func coalesceFrameMessages(first ServerMessage, recv <-chan ServerMessage, pending *[]ServerMessage) ServerMessage {
	frames, ok := messageFrames(first)
	if !ok {
		return first
	}
	const maxFrameBatch = 32
	for len(frames) < maxFrameBatch {
		select {
		case next, ok := <-recv:
			if !ok {
				return messageFromFrames(frames)
			}
			nextFrames, ok := messageFrames(next)
			if !ok {
				*pending = append(*pending, next)
				return messageFromFrames(frames)
			}
			frames = append(frames, nextFrames...)
		default:
			return messageFromFrames(frames)
		}
	}
	return messageFromFrames(frames)
}

func messageFrames(msg ServerMessage) ([]FrameRect, bool) {
	if msg.Frame != nil {
		return []FrameRect{*msg.Frame}, true
	}
	if msg.FrameBatch != nil && len(msg.FrameBatch.Frames) > 0 {
		return msg.FrameBatch.Frames, true
	}
	return nil, false
}

func messageFromFrames(frames []FrameRect) ServerMessage {
	if len(frames) == 1 {
		return ServerMessage{Frame: &frames[0]}
	}
	return ServerMessage{FrameBatch: &FrameBatch{Frames: frames}}
}

func encodeServerMessageForWS(msg ServerMessage, binaryV2 bool) ([]byte, error) {
	if !binaryV2 {
		return json.Marshal(msg)
	}
	return EncodeServerMessageBinaryPayload(msg)
}

// recordServerMessage tees an outbound ServerMessage onto the session tape:
// frame/cursor as OUTPUT (visual replay), status phase transitions and server
// clipboard as EVENT. nil recorder is a no-op. The desktop.v2 binary encoding
// is always recorded (re-encoded if the live client negotiated v1 JSON) so the
// tape format is independent of the live subprotocol.
func recordServerMessage(rec *Recorder, msg ServerMessage, body []byte, binaryV2 bool, lastPhase *Phase) {
	if rec == nil {
		return
	}
	switch {
	case msg.Frame != nil || msg.FrameBatch != nil || msg.Cursor != nil:
		recBody := body
		if !binaryV2 {
			if b, err := EncodeServerMessageBinaryPayload(msg); err == nil {
				recBody = b
			}
		}
		rec.WriteOutput(recBody)
	case msg.Status != nil:
		if msg.Status.Phase != *lastPhase {
			*lastPhase = msg.Status.Phase
			rec.WriteEvent(RecordingEvent{
				Type:    "status:" + string(msg.Status.Phase),
				Message: msg.Status.Message,
				Code:    msg.Status.Code,
			})
		}
	case msg.Clipboard != nil:
		rec.WriteEvent(RecordingEvent{Type: "clipboard-out", Message: msg.Clipboard.MIME})
	}
}
