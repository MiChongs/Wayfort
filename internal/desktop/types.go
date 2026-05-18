// Package desktop is Plan 17's new RDP backend. It defines a
// `DesktopWorker` abstraction so the gateway can drive multiple
// implementations (FreeRDP subprocess, gopher-rdp, IronRDP, …) over a
// uniform wire protocol.
//
// V1 M1 (this commit) ships:
//   - hand-written Go types that mirror proto/desktop/v1/*.proto
//   - a "dummy" worker that emits a moving test pattern, so the entire
//     pipeline (browser <-> WS <-> gateway <-> worker) is verifiable
//     without depending on libfreerdp
//   - the `freerdp-worker` binary stub at cmd/freerdp-worker that wraps
//     the dummy worker today; M2 replaces its core with libfreerdp 3.x
//
// M1.5 swaps these types for buf-generated bindings (see proto/desktop/v1/).
package desktop

import (
	"context"
	"encoding/json"
)

// ----- Control plane (browser → gateway, REST/ConnectRPC) -----

type Quality string

const (
	QualityAuto   Quality = "auto"
	QualityHigh   Quality = "high"
	QualityMedium Quality = "medium"
	QualityLow    Quality = "low"
)

type StartSessionRequest struct {
	NodeID   uint64  `json:"node_id"`
	Width    uint32  `json:"width"`
	Height   uint32  `json:"height"`
	DPI      uint32  `json:"dpi"`
	Keyboard string  `json:"keyboard"`
	Quality  Quality `json:"quality"`
	// Plan 17 M1: "dummy" runs the test-pattern worker.
	// M2 defaults to "freerdp" once libfreerdp is wired.
	Backend string `json:"backend"`
}

type StartSessionResponse struct {
	SessionID    string `json:"session_id"`
	RemoteWidth  uint32 `json:"remote_width"`
	RemoteHeight uint32 `json:"remote_height"`
}

type ResizeRequest struct {
	SessionID string `json:"session_id"`
	Width     uint32 `json:"width"`
	Height    uint32 `json:"height"`
}
type EndSessionRequest struct {
	SessionID string `json:"session_id"`
}
type GetStatusResponse struct {
	Phase    Phase  `json:"phase"`
	Code     uint32 `json:"code"`
	UptimeMS uint64 `json:"uptime_ms"`
}

// ----- Stream messages (browser <-> gateway <-> worker, WS binary / stdio) -----

type Encoding string

const (
	EncodingRawBGRA Encoding = "raw_bgra"
	EncodingJPEG    Encoding = "jpeg"
	EncodingPNG     Encoding = "png"
)

type Phase string

const (
	PhaseConnecting   Phase = "CONNECTING"
	PhaseHandshake    Phase = "HANDSHAKE"
	PhaseConnected    Phase = "CONNECTED"
	PhaseReconnecting Phase = "RECONNECTING"
	PhaseClosed       Phase = "CLOSED"
	PhaseError        Phase = "ERROR"
)

// ServerMessage is the union sent from worker → gateway → browser. Each
// instance carries exactly one populated field; the others are nil.
type ServerMessage struct {
	Frame     *FrameRect     `json:"frame,omitempty"`
	Cursor    *CursorUpdate  `json:"cursor,omitempty"`
	Status    *SessionStatus `json:"status,omitempty"`
	Bell      *struct{}      `json:"bell,omitempty"`
	Clipboard *ClipboardData `json:"clipboard,omitempty"`
}

type FrameRect struct {
	X        uint32   `json:"x"`
	Y        uint32   `json:"y"`
	Width    uint32   `json:"width"`
	Height   uint32   `json:"height"`
	Encoding Encoding `json:"encoding"`
	// Payload is base64 (json.RawMessage) in JSON wire format. In M1.5
	// proto wire it's `bytes`. The Go struct keeps base64 here so the same
	// type is used both for stdio JSON and WS JSON.
	Payload []byte `json:"payload"`
}

type CursorUpdate struct {
	HotspotX uint32 `json:"hotspot_x"`
	HotspotY uint32 `json:"hotspot_y"`
	PNG      []byte `json:"png"`
	// SystemKind names a generic X11/CSS cursor (default | pointer | text |
	// wait | crosshair | move | not-allowed | grab | grabbing | …) that the
	// browser should use INSTEAD of a bitmap. The worker sets this when the
	// server sends SET_NULL / SET_DEFAULT / pointer-system instead of a
	// bitmap PDU. When non-empty, PNG is ignored.
	SystemKind string `json:"system_kind,omitempty"`
	// Hidden tells the client to hide the cursor entirely (server requested
	// pointer hiding, e.g. game / fullscreen mode).
	Hidden bool `json:"hidden,omitempty"`
}

type SessionStatus struct {
	Phase   Phase  `json:"phase"`
	Message string `json:"message,omitempty"`
	Code    uint32 `json:"code,omitempty"`
}

type ClipboardData struct {
	MIME    string `json:"mime"`
	Payload []byte `json:"payload"`
}

// ClientMessage is the union sent from browser → gateway → worker.
type ClientMessage struct {
	Key       *InputKey      `json:"key,omitempty"`
	Mouse     *InputMouse    `json:"mouse,omitempty"`
	HB        *Heartbeat     `json:"hb,omitempty"`
	Clipboard *ClipboardData `json:"clipboard,omitempty"`
	Resize    *ResizeHint    `json:"resize,omitempty"`
}

type InputKey struct {
	Keysym  uint32 `json:"keysym"`
	Pressed bool   `json:"pressed"`
}

type InputMouse struct {
	X       int32  `json:"x"`
	Y       int32  `json:"y"`
	Buttons uint32 `json:"buttons"`
	Wheel   int32  `json:"wheel"`
}

// Mouse button mask values — used both in InputMouse.Buttons over the wire
// and by the freerdp-worker to compute press/release transitions before
// passing to libfreerdp's PTR_FLAGS_*. Kept in lockstep with web/src/
// lib/desktop/types.ts MOUSE_BUTTON_*.
const (
	MouseButtonMaskLeft   uint32 = 1 << 0
	MouseButtonMaskMiddle uint32 = 1 << 1
	MouseButtonMaskRight  uint32 = 1 << 2
)

type ResizeHint struct {
	Width  uint32 `json:"width"`
	Height uint32 `json:"height"`
}

type Heartbeat struct {
	TSMs uint64 `json:"ts_ms"`
}

// ----- DesktopWorker abstraction -----

// StartParams is what the gateway passes to a worker to begin a session.
// The worker uses it to authenticate against the target Windows host.
type StartParams struct {
	NodeID   uint64
	Host     string
	Port     int
	Username string
	Password string
	Domain   string
	Width    int
	Height   int
	Keyboard string
	Quality  Quality
	// RDP carries per-node connection-tuning knobs sourced from
	// node.proto_options (the `rdp` sub-object). Empty struct means "use
	// worker defaults" — backward-compatible with nodes authored before
	// this field existed.
	RDP RdpOptions
}

// DesktopWorker is the contract every worker implementation satisfies.
// FreeRDPWorker (M2) and DummyWorker (M1) both implement it. The gateway
// never knows which one is running underneath.
type DesktopWorker interface {
	// Start the session. Returns once the worker has acknowledged its
	// startup — actual remote connection happens asynchronously and
	// surfaces via Recv() ServerMessages.
	Start(ctx context.Context, p StartParams) error
	// Send forwards a client-side message (input, resize, clipboard, etc.)
	// to the worker. Non-blocking — drops to the worker's bounded queue.
	Send(msg ClientMessage) error
	// Recv returns a channel that yields server-side messages from the
	// worker. Closed when the worker exits.
	Recv() <-chan ServerMessage
	// Close terminates the worker (signals subprocess, drains channels).
	Close() error
}

// jsonEncode is the V1 M1 wire encoder for both stdio (gateway↔worker)
// and WebSocket data frames (gateway↔browser). Self-delimiting via the
// 4-byte big-endian length prefix that the reader/writer functions in
// internal/desktop/framed.go apply.
func jsonEncode(v any) ([]byte, error) { return json.Marshal(v) }
func jsonDecode[T any](b []byte) (T, error) {
	var v T
	err := json.Unmarshal(b, &v)
	return v, err
}
