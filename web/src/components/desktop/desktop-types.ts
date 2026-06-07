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
// Video transport choice. "auto" lets the server pick WebRTC when available;
// "webrtc" forces the hardware-decoded video track; "bitmap" forces the legacy
// JS/canvas path. VideoQuality biases the WebRTC bitrate.
export type VideoTransport = "auto" | "webrtc" | "bitmap"
export type VideoQuality = "smooth" | "balanced" | "sharp"
// High-DPI scale factor. "auto" follows the browser's devicePixelRatio; the
// numeric values force a fixed Windows display-scale percentage. freerdp backend
// only (the remote renders at physical-pixel resolution with matching scaling).
export type DpiScale = "auto" | "100" | "125" | "150" | "175" | "200" | "250" | "300"

export interface DesktopSettings {
  // Display
  scaleMode: ScaleMode
  // Dynamic resolution: when on (and the node enabled rdp.dynamic_resolution),
  // the remote desktop resolution follows the browser window live via RDPEDISP —
  // always native 1:1, no scaling blur. Off = smart-sizing: the remote stays at
  // the connect-time resolution and `scaleMode` scales the canvas to fit. Off by
  // default; only the freerdp backend honours it.
  dynamicResolution: boolean
  // Video transport + WebRTC quality. Changing either reconnects (the codec /
  // GFX choice is fixed at connect time).
  videoTransport: VideoTransport
  videoQuality: VideoQuality
  // Server-side resolution preference. Server may not honour exactly —
  // worker reports the negotiated value back via `desktop_resize` event.
  preferredWidth: number
  preferredHeight: number
  colorDepth: 16 | 24 | 32
  smoothScaling: boolean
  // High-DPI: render the remote at physical-pixel resolution (logical ×
  // scale) with matching Windows display scaling, so text/UI stay crisp on
  // HiDPI screens. On by default. dpiScale "auto" follows devicePixelRatio.
  // Changing either reconnects (the resolution is fixed at connect time).
  highDpi: boolean
  dpiScale: DpiScale
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
  // Which compositing surface the bitmap path resolved to: "webgpu" (raw-BGRA
  // GPU fast path) or "canvas2d" (fallback). null on the WebRTC/IronRDP paths
  // and until the renderer picks one.
  renderSurface?: "webgpu" | "canvas2d" | null
  // Active video transport label for the status bar, e.g. "WebRTC · VP9" when
  // the hardware-decoded track is playing or "JS 位图" on the canvas path.
  // null until decided.
  transport?: string | null
}
