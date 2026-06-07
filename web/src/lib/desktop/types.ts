// Plan 17 — wire types for the new desktop subsystem. Hand-written to
// mirror proto/desktop/v1/*.proto until buf generation is wired in M1.5.
// M1 uses JSON over WebSocket binary frames; the schema and field layout
// match the proto so the type swap is invisible to consumers.

export type Quality = "auto" | "high" | "medium" | "low"
// h264 = RDPGFX AVC420 single-stream YUV4:2:0, decoded by
// WebCodecs.VideoDecoder when supported (probe via capabilities.ts).
// rfx = RemoteFX progressive codec — wire-tagged today but no browser
// decoder yet; servers that only emit rfx will get it forwarded and the
// client will fall through to "unsupported" handling.
export type Encoding = "raw_bgra" | "zlib_bgra" | "jpeg" | "png" | "h264" | "rfx"
export type CursorEncoding = "raw_bgra" | "png" | "system"

export type Phase =
  | "CONNECTING"
  | "HANDSHAKE"
  | "CONNECTED"
  | "RECONNECTING"
  | "CLOSED"
  | "ERROR"

// ----- Control plane (REST today, ConnectRPC tomorrow) -----

export interface StartSessionRequest {
  node_id: number
  // width/height are the LOGICAL desktop resolution; with scale>100 the gateway
  // multiplies them to the physical render resolution.
  width: number
  height: number
  dpi?: number
  // High-DPI desktop scale factor in percent (100 = none, 150, 200, …). Derived
  // from devicePixelRatio (or the user's explicit choice) so the remote renders
  // at physical-pixel resolution with matching Windows display scaling — crisp
  // on HiDPI screens. freerdp backend only.
  scale?: number
  keyboard?: string
  quality?: Quality
  backend?: DesktopBackend
  // Browser decoder capabilities. The manager uses this to disable
  // GFX/H.264 negotiation up front for browsers that lack
  // WebCodecs.VideoDecoder, so a misnegotiated codec never reaches a
  // client that can't render it. Populate via
  // `collectClientCapabilities()` from lib/desktop/capabilities.ts.
  client_caps?: ClientCaps
  // video_transport is the user's explicit choice: "" / "auto" (manager picks),
  // "webrtc" (force the WebRTC track), or "bitmap" (force the legacy JS/canvas
  // path). video_quality biases the WebRTC bitrate: "smooth" | "balanced" |
  // "sharp". Both come from the desktop settings sheet.
  video_transport?: string
  video_quality?: string
}

/**
 * DesktopBackend names the renderer the gateway should provision.
 *
 *  - `"freerdp"` — Plan 17–28 worker subprocess (libfreerdp via cgo) +
 *    our self-rolled WebSocket frame protocol. The browser side mounts
 *    FrameClient + OffscreenCanvas. **Legacy** — PR-C removes it.
 *  - `"dummy"` — in-process test pattern worker, same wire shape.
 *  - `"ironrdp"` — Plan 29 path. Browser runs the IronRDP Wasm client
 *    (@devolutions/iron-remote-desktop-rdp) and talks WebSocket directly
 *    to a Devolutions Gateway subprocess we supervise. The Go gateway
 *    only signs the pre-auth JWT.
 */
export type DesktopBackend = "freerdp" | "dummy" | "ironrdp"

/**
 * StartSessionResponse covers both legacy (freerdp/dummy) and Plan 29
 * (ironrdp) paths. `backend` echoes the resolved backend so the React
 * layer can pick the right renderer; the ironrdp-specific fields are
 * zero/empty on legacy paths and the browser ignores them then.
 */
export interface StartSessionResponse {
  session_id: string
  remote_width: number
  remote_height: number
  backend?: DesktopBackend

  // WebRTC video path. `video_mode === "vp8"` means the browser must set up an
  // RTCPeerConnection and render the desktop in a <video> element (GPU decode)
  // instead of the canvas/FrameClient bitmap path. `ice_servers` is the STUN /
  // TURN config to feed the peer connection. Both absent on the legacy path.
  video_mode?: string
  ice_servers?: RTCIceServer[]

  // ironrdp-only fields. Present iff backend === "ironrdp".
  gateway_url?: string
  token?: string
  destination?: string
  username?: string
  password?: string
  domain?: string
}

// ----- Data plane (WS binary) -----

export interface FrameRect {
  x: number
  y: number
  width: number
  height: number
  encoding: Encoding
  // keyframe is meaningful only on codec-encoded encodings (h264 /
  // rfx). The browser-side VideoDecoder needs an EncodedVideoChunk
  // typed "key" for a decode entry point and "delta" otherwise; this
  // flag carries the worker's classification. Independently
  // decodable encodings (raw_bgra, jpeg, png, zlib_bgra) ignore it.
  keyframe?: boolean
  // base64-encoded bytes in JSON wire; switch to Uint8Array when the proto
  // wire format takes over in M1.5.
  payload: string
}

export interface FrameBatch {
  frames: FrameRect[]
}

export interface CursorUpdate {
  hotspot_x: number
  hotspot_y: number
  width?: number
  height?: number
  encoding: CursorEncoding
  payload?: string // base64
  // Optional X11 / FreeRDP system cursor name (default | pointer | text |
  // wait | crosshair | …). Set by the worker when the server requests a
  // built-in shape instead of a bitmap; client maps it via
  // desktop-cursor-map.ts to a CSS cursor keyword.
  system_kind?: string
  // Hide the pointer entirely (server requested null cursor).
  hidden?: boolean
}

export interface SessionStatus {
  phase: Phase
  message?: string
  code?: number
}

export interface ClipboardData {
  mime: string
  payload: string // base64
}

// AudioData is one chunk of redirected remote audio (rdpsnd). pcm is base64
// raw interleaved little-endian signed PCM at sample_rate / channels / bits.
export interface AudioData {
  sample_rate: number
  channels: number
  bits: number
  pcm: string
}

// WebRTCSignal is one signaling message on the desktop WS for the WebRTC video
// path. The browser offers; the gateway answers; both trickle ICE. Field names
// mirror RTCSessionDescription / RTCIceCandidateInit so each can be passed
// straight to the WebRTC stack.
export interface WebRTCSignal {
  type: "offer" | "answer" | "candidate"
  sdp?: string
  candidate?: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}

export interface ServerMessage {
  frame?: FrameRect
  frame_batch?: FrameBatch
  cursor?: CursorUpdate
  status?: SessionStatus
  bell?: Record<string, never>
  clipboard?: ClipboardData
  audio?: AudioData
  // Gateway → browser SDP answer / ICE candidate for the WebRTC video track.
  webrtc?: WebRTCSignal
  // Heartbeat-ack echoed by the gateway — carries the ts_ms the client sent so
  // the round-trip latency is `Date.now() - hb.ts_ms`.
  hb?: Heartbeat
}

// InputKey: a physical key event. `scancode` (RDP set-1 make code) + `extended`
// is the primary path — it composes with modifiers so shortcuts work. `keysym`
// is the legacy/fallback path for keys without a scancode mapping. Send whichever
// the browser resolved; the worker prefers scancode.
export interface InputKey { keysym?: number; scancode?: number; extended?: boolean; pressed: boolean }
export interface InputMouse { x: number; y: number; buttons: number; wheel: number }
export interface ResizeHint { width: number; height: number }
export interface Heartbeat { ts_ms: number }

/**
 * Client-side decoder capability hints. The browser sends one of these
 * once over the WS right after `open`; the worker uses it to decide
 * whether to negotiate RDPGFX H.264 with the upstream server. A server
 * that can only encode AVC444 H.264 still gets it advertised as
 * AVC420, the wire payload arrives as `Encoding=h264` and gets
 * handled by capabilities.ts in the worker.
 */
export interface ClientCaps {
  h264: boolean
  rfx: boolean
  imageDecoder: boolean
  // webrtc reports that the browser can run an RTCPeerConnection and decode the
  // VP8 video track. When true (and the server enabled it), the gateway streams
  // video over WebRTC instead of WS bitmap frames.
  webrtc: boolean
  // webrtcVP9 reports VP9 decode support so the gateway can pick the sharper
  // screen-content codec.
  webrtcVP9: boolean
  // webrtcAV1 reports AV1 WebRTC decode support. The gateway selects AV1 (most
  // bandwidth-efficient at equal quality) only when this is true AND the node
  // opted in (rdp.prefer_av1); otherwise it falls back to VP9/VP8.
  webrtcAV1: boolean
}

/** Region the client wants the server to redraw immediately. All-zero
 *  dimensions mean "the entire desktop". */
export interface RefreshRect {
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface ClientMessage {
  key?: InputKey
  mouse?: InputMouse
  hb?: Heartbeat
  clipboard?: ClipboardData
  resize?: ResizeHint
  caps?: ClientCaps
  refresh?: RefreshRect
  // text is IME-composed (or committed) Unicode text — the final string an
  // input method assembled ("你好"), sent on compositionend. The worker replays
  // it as per-character Unicode keyboard events on the remote.
  text?: string
  // WebRTC video path. `webrtc` carries the browser's SDP offer / ICE
  // candidates to the gateway bridge. `video_mode: "bitmap"` switches the
  // worker back to WS frames when WebRTC fails (the fallback). `request_keyframe`
  // is gateway-internal (set on PLI) but typed here for completeness.
  webrtc?: WebRTCSignal
  video_mode?: string
  request_keyframe?: boolean
}

// ----- Bit layouts (kept in lockstep with renderer.worker.ts + worker_dummy.go) -----

export const MOUSE_BUTTON_LEFT = 1 << 0
export const MOUSE_BUTTON_MIDDLE = 1 << 1
export const MOUSE_BUTTON_RIGHT = 1 << 2

// base64 → Uint8Array. Hot path during frame decode — keep this allocation-
// light by reusing the browser-native atob and a single Uint8Array.
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
