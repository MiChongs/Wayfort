// Shared types for the desktop viewer subcomponents. Kept in a small
// dedicated file so subcomponents don't import from the main
// desktop-display.tsx (which would create a circular dep through
// toolbar / settings / palette / etc).

import type { DecoderPath } from "@/lib/desktop/canvas-renderer"
import type { Encoding } from "@/lib/desktop/types"

export type DesktopStatus =
  | "loading-script"   // OffscreenCanvas worker loading
  | "connecting"       // WS open, waiting for first SessionStatus
  | "handshake"        // server is negotiating
  | "connected"        // remote desktop is live
  | "reconnecting"     // WS dropped; backoff retry in progress
  | "closed"           // server-side disconnect, no retry
  | "error"            // unrecoverable

export type ScaleMode = "fit" | "actual" | "center" | "stretch"
export type ClipboardDirection = "both" | "in-only" | "out-only" | "off"

export interface DesktopSettings {
  // Display
  scaleMode: ScaleMode
  // Server-side resolution preference. Server may not honour exactly —
  // worker reports the negotiated value back via `desktop_resize` event.
  preferredWidth: number
  preferredHeight: number
  colorDepth: 16 | 24 | 32
  smoothScaling: boolean
  // Input
  keyboardLayout: string  // e.g. "us", "de", "fr", "zh"
  // Sync lock-state keys (CapsLock / NumLock / ScrollLock) with the
  // browser on (re)connect so remote and local agree from the start.
  syncLocks: boolean
  swapMiddleButton: boolean   // some workflows expect middle = right
  // Clipboard
  clipboardDirection: ClipboardDirection
  clipboardConfirmLines: number  // > N → confirm before paste; 0 disables
  // Audio
  audioPlayback: boolean
  // Cursor
  cursorMode: "remote" | "css-only" | "hidden"
  // Stability
  reconnectOnDrop: boolean
}

export interface SessionStats {
  bytesIn: number
  bytesOut: number
  latencyMs: number | null
  fps: number | null
  // Block B extensions — moving averages over the last ~1s window, plus
  // a monotonically-rising counter for frames the renderer coalesced
  // away because a newer one arrived before the previous painted.
  // `null` means "not measurable on this path" so the UI can render
  // "—" without confusing it with a zero. The legacy freerdp + worker
  // path fills all of these; the IronRDP Wasm path leaves them null.
  avgDecodeMs?: number | null
  avgPaintMs?: number | null
  droppedFrames?: number | null
  // Dominant frame encoding over the last 1 s window. `null` until
  // the renderer paints its first frame so the perf panel can show
  // "—" instead of a stale entry.
  codec?: Encoding | null
  // Which decode path the renderer actually used: "videodecoder"
  // means GPU H.264; "imagedecoder" / "imagebitmap" are native image
  // paths; "js" is the fast-png / jpeg-js / BGRA byte-swap path.
  decoderPath?: DecoderPath | null
}
