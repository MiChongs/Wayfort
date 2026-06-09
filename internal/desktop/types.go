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
	NodeID uint64 `json:"node_id"`
	// Width / Height are the LOGICAL desktop resolution the user wants (the
	// "期望分辨率" the remote desktop behaves as). When Scale > 100 the gateway
	// multiplies them by Scale/100 to get the physical render resolution.
	Width  uint32 `json:"width"`
	Height uint32 `json:"height"`
	DPI    uint32 `json:"dpi"`
	// Scale is the high-DPI desktop scale factor in percent (100 = none, 150,
	// 200, …). The browser derives it from devicePixelRatio (or the user's
	// explicit choice) so the remote renders at physical-pixel resolution with
	// matching Windows display scaling — crisp text/UI on HiDPI screens. 0 is
	// treated as 100. freerdp backend only (ironrdp's Wasm client has no
	// scale-factor API and renders at the logical resolution).
	Scale    uint32  `json:"scale,omitempty"`
	Keyboard string  `json:"keyboard"`
	Quality  Quality `json:"quality"`
	// Plan 17 M1: "dummy" runs the test-pattern worker.
	// M2 defaults to "freerdp" once libfreerdp is wired.
	Backend string `json:"backend"`
	// ClientCaps tells the manager what the browser's decoder can
	// actually handle so it can pick a codec mix the client will
	// render — e.g. an old Safari without WebCodecs.VideoDecoder
	// must NOT have GFX/H.264 negotiated upstream, otherwise libfreerdp
	// reaches `connected` but every frame arrives in a format the
	// client drops on the floor. The browser collects this via
	// `collectClientCapabilities()` (lib/desktop/capabilities.ts)
	// before POSTing the start request. Nil = legacy / unknown client;
	// the manager assumes full support to keep older builds working.
	ClientCaps *ClientCaps `json:"client_caps,omitempty"`
	// VideoTransport is the user's explicit choice of video path:
	//   "" / "auto"  → manager decides (WebRTC when the browser + operator
	//                  both allow it, else the JS bitmap path);
	//   "webrtc"     → force the WebRTC video track (still needs the operator's
	//                  desktop.webrtc.enabled; ignored on non-freerdp backends);
	//   "bitmap"     → force the legacy JS/canvas path (never WebRTC).
	// Surfaced in the desktop settings sheet; changing it reconnects.
	VideoTransport string `json:"video_transport,omitempty"`
	// VideoQuality biases the WebRTC encoder bitrate: "smooth" (lower bitrate,
	// best on slow links), "balanced" (default), "sharp" (high bitrate, crisp
	// text). Empty = balanced. Only affects the WebRTC path.
	VideoQuality string `json:"video_quality,omitempty"`
}

type StartSessionResponse struct {
	SessionID    string `json:"session_id"`
	RemoteWidth  uint32 `json:"remote_width"`
	RemoteHeight uint32 `json:"remote_height"`
	// Backend echoes which backend the manager picked. Browsers compare
	// this against their build to decide whether to attach FrameClient
	// (legacy freerdp/dummy) or instantiate iron-remote-desktop (ironrdp).
	Backend string `json:"backend,omitempty"`
	// VideoMode tells the browser which video transport the worker is producing:
	// "vp8" means it must set up the WebRTC <video> path (and the WS carries no
	// bitmap frames unless it falls back); "" / "bitmap" means the legacy
	// canvas/FrameClient path. Only ever "vp8" for the freerdp backend with a
	// WebRTC-capable browser and desktop.webrtc.enabled.
	VideoMode string `json:"video_mode,omitempty"`
	// ICEServers is the WebRTC ICE configuration (STUN / TURN) the browser feeds
	// to its RTCPeerConnection. Populated only when VideoMode=="vp8". TURN
	// credentials are meant for the client, so handing them over here is by
	// design — without them the browser can't authenticate to the relay.
	ICEServers []ICEServer `json:"ice_servers,omitempty"`

	// ----- ironrdp backend only -----
	// IronRDP is the Devolutions Wasm RDP client running inside the
	// browser. It needs the destination + creds + a short-lived JWT it
	// presents to the Devolutions Gateway as a pre-auth ticket. These
	// fields are zero for freerdp/dummy responses; the browser MUST
	// ignore them unless Backend == "ironrdp".
	GatewayURL  string `json:"gateway_url,omitempty"`
	Token       string `json:"token,omitempty"`
	Destination string `json:"destination,omitempty"`
	Username    string `json:"username,omitempty"`
	Password    string `json:"password,omitempty"`
	Domain      string `json:"domain,omitempty"`
}

// ICEServer mirrors the browser's RTCIceServer so the gateway can hand the
// operator-configured STUN/TURN servers to the client's RTCPeerConnection in
// StartSessionResponse.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
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
	EncodingRawBGRA  Encoding = "raw_bgra"
	EncodingJPEG     Encoding = "jpeg"
	EncodingPNG      Encoding = "png"
	EncodingZlibBGRA Encoding = "zlib_bgra"
	// EncodingZstdBGRA is a zstd-compressed BGRA surface — the worker emits it
	// instead of zlib_bgra when the browser advertises zstd decode support
	// (ClientCaps.Zstd). zstd decompresses ~3× faster than zlib at a better
	// ratio, so it cuts both decode time and bandwidth for the lossless path.
	EncodingZstdBGRA Encoding = "zstd_bgra"
	// EncodingH264 / EncodingRFX carry RDPGFX SURFACE_COMMAND payloads
	// forwarded by libfreerdp untouched. They are AVC420 (H.264
	// Constrained Baseline, single YUV4:2:0 stream — AVC444 is
	// deliberately disabled in client.go so the browser side can decode
	// with WebCodecs.VideoDecoder which only accepts a single stream)
	// and RemoteFX progressive codec respectively. The browser side
	// uses these strings to dispatch to the right decoder; servers
	// without GFX negotiate down to raw_bgra so this is additive.
	EncodingH264 Encoding = "h264"
	EncodingRFX  Encoding = "rfx"
)

type CursorEncoding string

const (
	CursorEncodingRawBGRA CursorEncoding = "raw_bgra"
	CursorEncodingPNG     CursorEncoding = "png"
	CursorEncodingSystem  CursorEncoding = "system"
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
	Frame      *FrameRect     `json:"frame,omitempty"`
	FrameBatch *FrameBatch    `json:"frame_batch,omitempty"`
	Cursor     *CursorUpdate  `json:"cursor,omitempty"`
	Status     *SessionStatus `json:"status,omitempty"`
	Bell       *struct{}      `json:"bell,omitempty"`
	Clipboard  *ClipboardData `json:"clipboard,omitempty"`
	// Audio carries a chunk of redirected PCM from the remote desktop
	// (rdpsnd). Travels over the binary wire's JSON-fallback frame; the browser
	// plays it via Web Audio. High-volume + best-effort (dropped under
	// backpressure), so it is never written to the session recording.
	Audio *AudioData `json:"audio,omitempty"`
	// Video is one VP8 access unit for the WebRTC video path. The worker emits
	// it in VideoMode "vp8"; the gateway intercepts it (never forwarded to the
	// browser WS) and writes it to the Pion video track. The browser sees the
	// frames via WebRTC <video>, not here.
	Video *VideoData `json:"video,omitempty"`
	// WebRTC carries SDP answer / ICE candidates from the gateway's Pion peer
	// connection back to the browser. Gateway-originated; never reaches the
	// worker. Present only on the browser hop.
	WebRTC *WebRTCSignal `json:"webrtc,omitempty"`
	// HB echoes a client heartbeat straight back so the browser can measure
	// round-trip latency (ts_ms is the client's send time; RTT = now - ts_ms).
	// Gateway-originated on the browser hop — the worker never sees it.
	HB *Heartbeat `json:"hb,omitempty"`
}

// WebRTCSignal is one signaling message on the desktop WS for the WebRTC video
// path. The browser offers (Type "offer"); the gateway answers (Type "answer");
// both trickle ICE (Type "candidate"). Mirrors RTCSessionDescription /
// RTCIceCandidateInit so each side can hand the payload straight to its WebRTC
// stack. The signal rides the existing desktop WS — no extra socket.
type WebRTCSignal struct {
	Type string `json:"type"` // "offer" | "answer" | "candidate"
	// SDP is set for "offer" / "answer".
	SDP string `json:"sdp,omitempty"`
	// Candidate fields are set for "candidate" (trickle ICE), mirroring
	// RTCIceCandidateInit. SDPMLineIndex is a pointer so a literal 0 survives
	// JSON (browsers reject a candidate with a missing/!=offer mline index).
	Candidate     string  `json:"candidate,omitempty"`
	SDPMid        *string `json:"sdpMid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdpMLineIndex,omitempty"`
}

// VideoData is one encoded video access unit for the WebRTC track. Data is
// base64 (worker→gateway hop only); the gateway decodes it once and feeds raw
// bytes to Pion. Codec is "vp8" today.
type VideoData struct {
	Codec    string `json:"codec"`
	Keyframe bool   `json:"keyframe"`
	Width    uint32 `json:"width"`
	Height   uint32 `json:"height"`
	Data     string `json:"data"`
}

// AudioData is one chunk of redirected audio. PCM is base64 raw little-endian
// signed PCM at SampleRate/Channels/Bits (always WAVE_FORMAT_PCM — the worker's
// rdpsnd device advertises PCM only so no codec decode is needed).
type AudioData struct {
	SampleRate uint32 `json:"sample_rate"`
	Channels   uint32 `json:"channels"`
	Bits       uint32 `json:"bits"`
	PCM        string `json:"pcm"`
}

type FrameBatch struct {
	Frames []FrameRect `json:"frames"`
}

type FrameRect struct {
	X        uint32   `json:"x"`
	Y        uint32   `json:"y"`
	Width    uint32   `json:"width"`
	Height   uint32   `json:"height"`
	Encoding Encoding `json:"encoding"`
	// Keyframe is meaningful only for codec-encoded encodings (h264 /
	// rfx) where the browser-side decoder needs to know whether it can
	// start a fresh decode pipeline or has to wait for a key frame.
	// `raw_bgra` / `zlib_bgra` / `jpeg` / `png` ignore this field — those
	// encodings are independently decodable per frame. JSON-omitted on
	// false so existing wire tests stay green.
	Keyframe bool `json:"keyframe,omitempty"`
	// Payload is base64 (json.RawMessage) in JSON wire format. In M1.5
	// proto wire it's `bytes`. The Go struct keeps base64 here so the same
	// type is used both for stdio JSON and WS JSON.
	Payload []byte `json:"payload"`
}

type CursorUpdate struct {
	HotspotX uint32         `json:"hotspot_x"`
	HotspotY uint32         `json:"hotspot_y"`
	Width    uint32         `json:"width,omitempty"`
	Height   uint32         `json:"height,omitempty"`
	Encoding CursorEncoding `json:"encoding"`
	Payload  []byte         `json:"payload,omitempty"`
	// SystemKind names a generic X11/CSS cursor (default | pointer | text |
	// wait | crosshair | move | not-allowed | grab | grabbing | …) that the
	// browser should use INSTEAD of a bitmap. The worker sets this when the
	// server sends SET_DEFAULT / pointer-system instead of a bitmap PDU.
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
	// Caps is sent once by the browser right after WS open and carries
	// the decoder capabilities. Mostly informational at this point —
	// the actual gate happens at session-start time via
	// StartSessionRequest.ClientCaps which overrides RdpOptions
	// before libfreerdp connects. Logging this on the WS hop keeps a
	// breadcrumb if a client lies about what it can decode.
	Caps *ClientCaps `json:"caps,omitempty"`
	// Refresh asks the worker to send an RDP `Refresh Rect` PDU so the
	// server immediately redraws the named region (or the entire
	// canvas if x/y/width/height are zero). The browser triggers this
	// when WebCodecs.VideoDecoder errors out and needs a new IDR
	// keyframe to restart decoding — without it, the screen stays
	// frozen until the server emits the next natural keyframe.
	Refresh *RefreshRect `json:"refresh,omitempty"`
	// Text is IME-composed (or otherwise committed) Unicode text from the
	// browser — e.g. a Chinese/Japanese/Korean phrase the local input method
	// assembled ("你好"). The browser sends the final string on `compositionend`
	// (raw keystrokes are suppressed while composing); the worker replays it as
	// per-character Unicode keyboard events so it lands on the remote regardless
	// of the server keyboard layout. Recorded to the input-audit tape.
	Text string `json:"text,omitempty"`
	// VideoMode switches the worker's video production: "vp8" makes the run
	// loop encode the framebuffer to VP8 for the WebRTC track (and stop dirty-
	// bitmap frames); "bitmap" (or empty) restores the legacy WebSocket frame
	// path. Driven by the gateway from the Pion connection state.
	VideoMode string `json:"video_mode,omitempty"`
	// RequestKeyframe forces the next VP8 frame to be a keyframe. The gateway
	// sets it on a WebRTC PLI (browser lost the stream) and on (re)connect.
	RequestKeyframe bool `json:"request_keyframe,omitempty"`
	// SetBitrateKbps live-retunes the WebRTC video encoder's target bitrate
	// (kbps). The gateway drives it from the GCC bandwidth estimate so the
	// stream tracks available capacity: it climbs toward the quality-tier
	// ceiling on a fat link (sharp text) and backs off under congestion (low
	// latency, bounded flow). 0 = leave unchanged.
	SetBitrateKbps int `json:"set_bitrate_kbps,omitempty"`
	// WebRTC carries the browser's SDP offer / ICE candidates to the gateway's
	// Pion peer connection. The gateway consumes these (they never reach the
	// worker) and replies via ServerMessage.WebRTC.
	WebRTC *WebRTCSignal `json:"webrtc,omitempty"`
}

// RefreshRect mirrors the area carried by an RDP MS-RDPBCGR 2.2.11.2.2
// Refresh Rect PDU. All-zero means "the whole desktop", which is what
// the browser sends on a decoder error.
type RefreshRect struct {
	X      uint32 `json:"x,omitempty"`
	Y      uint32 `json:"y,omitempty"`
	Width  uint32 `json:"width,omitempty"`
	Height uint32 `json:"height,omitempty"`
}

// ClientCaps mirrors the TypeScript ClientCaps shape (web/src/lib/
// desktop/types.ts) so JSON unmarshalling is a memcpy.
type ClientCaps struct {
	H264         bool `json:"h264"`
	RFX          bool `json:"rfx"`
	ImageDecoder bool `json:"imageDecoder"`
	// Zstd reports the browser can inflate a zstd_bgra surface (decode worker
	// bundles a zstd-wasm decoder). When true the worker compresses lossless
	// BGRA rects with zstd instead of zlib — faster client decode + less wire.
	Zstd bool `json:"zstd"`
	// WebRTC reports that the browser can run an RTCPeerConnection and decode
	// the VP8 video track. When true (and desktop.webrtc.enabled), the manager
	// starts the worker in VP8 video mode and the gateway streams video over a
	// Pion track instead of WS bitmap frames. False/absent keeps the legacy
	// path, so older browsers keep working.
	WebRTC bool `json:"webrtc"`
	// WebRTCVP9 reports the browser can decode a VP9 WebRTC track. VP9's
	// screen-content mode is markedly sharper than VP8 for desktop UI/text, so
	// the manager prefers it when the browser supports it and the operator
	// configured desktop.webrtc.codec = vp9. Falls back to VP8 otherwise.
	WebRTCVP9 bool `json:"webrtcVP9"`
	// WebRTCAV1 reports the browser can decode an AV1 WebRTC track. AV1 is the
	// most bandwidth-efficient codec at equal quality (~30-50% less than VP9 on
	// screen content) but the heaviest to encode; the manager selects it only
	// when the browser advertises it AND the node opted in (rdp.prefer_av1).
	// Falls back to VP9/VP8 otherwise.
	WebRTCAV1 bool `json:"webrtcAV1"`
}

type InputKey struct {
	// Scancode (RDP set-1 make code) + Extended is the primary path: it composes
	// with modifier keys on the server, so shortcuts (Ctrl+C, Alt+Tab, Win+L …)
	// work. Keysym is the legacy/fallback path for keys the browser couldn't map
	// to a scancode. The worker prefers Scancode when non-zero.
	Keysym   uint32 `json:"keysym,omitempty"`
	Scancode uint32 `json:"scancode,omitempty"`
	Extended bool   `json:"extended,omitempty"`
	Pressed  bool   `json:"pressed"`
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
	// Scale is the RDP desktop scale factor in percent (100 = none). Width /
	// Height are already the PHYSICAL render resolution (logical × Scale/100);
	// the worker additionally writes Scale to FreeRDP_DesktopScaleFactor /
	// FreeRDP_DeviceScaleFactor so the remote Windows applies display scaling —
	// giving crisp, correctly-sized UI on HiDPI clients instead of a tiny or
	// upscaled-blurry desktop. 0 / 100 = no scaling.
	Scale    int
	Keyboard string
	Quality  Quality
	// RDP carries per-node connection-tuning knobs sourced from
	// node.proto_options (the `rdp` sub-object). Empty struct means "use
	// worker defaults" — backward-compatible with nodes authored before
	// this field existed.
	RDP RdpOptions
	// SOCKSHost / SOCKSPort point the worker's libfreerdp transport at a
	// gateway-local SOCKS5 listener that tunnels the TCP connection through
	// the node's JumpServer proxy chain (SSH bastion / SOCKS5 hops). Empty
	// host = direct dial to Host:Port (no proxy chain configured for the node).
	// The worker still connects to Host:Port — it just routes via the proxy.
	SOCKSHost string
	SOCKSPort int
	// DriveName / DrivePath redirect a gateway-side folder into the session as
	// a mounted drive (rdpdr filesystem redirection) so the user can move files
	// between the browser host and the remote desktop. Empty DrivePath leaves
	// device redirection off. DriveName is the share label shown in the remote
	// "This PC" (ASCII; defaults to "JumpServer" when blank).
	DriveName string
	DrivePath string
	// VideoMode selects the worker's video transport at connect AND, for the
	// WebRTC path, the codec: "vp8" or "vp9" makes the worker disable the RDPGFX
	// pipeline and encode the composited framebuffer with that codec for the
	// gateway's WebRTC track; "" / "bitmap" keeps the legacy dirty-bitmap path.
	// Decided by the manager from the user's transport choice, browser support,
	// and desktop.webrtc.{enabled,codec}; can't change mid-session (GFX choice).
	VideoMode string
	// WebRTC video path tuning. VideoBitrateKbps / VideoFPS configure the VP8
	// encoder when the gateway switches the worker into "vp8" video mode. Zero
	// means worker defaults (8000 kbps / 30 fps).
	VideoBitrateKbps int
	VideoFPS         int

	// RD Gateway (MS-TSGU) — resolved by the manager from the node's RdpOptions.
	// GatewayHost empty = no gateway (direct / proxy-chain dial). When set, the
	// worker tunnels the RDP connection through this Microsoft RD Gateway.
	GatewayHost string
	GatewayPort int
	// GatewayUseSameCredentials makes the gateway reuse the target's credentials;
	// otherwise GatewayUsername/Password/Domain carry a dedicated gateway login.
	GatewayUseSameCredentials bool
	GatewayUsername           string
	GatewayPassword           string
	GatewayDomain             string
	// GatewayTransport: "auto" | "http" | "rpc".
	GatewayTransport string
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
