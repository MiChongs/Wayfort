// Plan 17 — wire types for the new desktop subsystem. Hand-written to
// mirror proto/desktop/v1/*.proto until buf generation is wired in M1.5.
// M1 uses JSON over WebSocket binary frames; the schema and field layout
// match the proto so the type swap is invisible to consumers.

export type Quality = "auto" | "high" | "medium" | "low"
export type Encoding = "raw_bgra" | "jpeg" | "png"

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
  backend?: "freerdp" | "dummy"
}

export interface StartSessionResponse {
  session_id: string
  remote_width: number
  remote_height: number
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

export interface CursorUpdate {
  hotspot_x: number
  hotspot_y: number
  png: string // base64
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
  cursor?: CursorUpdate
  status?: SessionStatus
  bell?: Record<string, never>
  clipboard?: ClipboardData
}

export interface InputKey { keysym: number; pressed: boolean }
export interface InputMouse { x: number; y: number; buttons: number; wheel: number }
export interface ResizeHint { width: number; height: number }
export interface Heartbeat { ts_ms: number }

export interface ClientMessage {
  key?: InputKey
  mouse?: InputMouse
  hb?: Heartbeat
  clipboard?: ClipboardData
  resize?: ResizeHint
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
