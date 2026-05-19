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
  width: number
  height: number
  dpi?: number
  keyboard?: string
  quality?: Quality
  backend?: DesktopBackend
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

export interface ServerMessage {
  frame?: FrameRect
  frame_batch?: FrameBatch
  cursor?: CursorUpdate
  status?: SessionStatus
  bell?: Record<string, never>
  clipboard?: ClipboardData
}

export interface InputKey { keysym: number; pressed: boolean }
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
}

export interface ClientMessage {
  key?: InputKey
  mouse?: InputMouse
  hb?: Heartbeat
  clipboard?: ClipboardData
  resize?: ResizeHint
  caps?: ClientCaps
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
