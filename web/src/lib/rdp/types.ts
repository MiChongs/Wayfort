// Public types for the new Pixi-based RDP/VNC client (Plan 15).
//
// The client wraps Guacamole.Client (protocol + input) with a custom WebGL
// renderer (PixiCompositor) and a plugin host (recording / screenshot /
// annotation / minimap / stats). The wrapper exposes a small imperative
// surface that React components and the use-rdp hook drive.

import type { GuacQuality, GuacMetrics } from "@/lib/ws/guacamole-client"

export type RDPViewportMode = "fit" | "fill" | "actual"

export interface RDPViewportState {
  mode: RDPViewportMode
  // Current zoom factor — 1.0 = 100%. Bounded by [MIN_ZOOM, MAX_ZOOM].
  scale: number
  // Translation in CSS pixels relative to the centred origin.
  offsetX: number
  offsetY: number
  // Remote desktop dimensions reported by guacd via Display.onresize.
  remoteWidth: number
  remoteHeight: number
}

export interface RDPMetrics extends GuacMetrics {
  // Pixi-rendered FPS (independent of guacd push rate).
  fps?: number
  // Number of guacd instructions parsed per second.
  instructionsPerSec?: number
  // Total JS heap usage if the browser exposes performance.memory.
  jsHeapMb?: number
}

export interface RDPClientOptions {
  protocol: "rdp" | "vnc"
  nodeId: number
  host: HTMLElement
  // Plumbed through to the Guacamole connect URL — see Plan 13.B.2/3.
  quality?: GuacQuality
  enableAudio?: boolean
  enableClipboard?: boolean
  keyboardLayout?: string
  // Wire events back to React/state machine.
  onStateChange?: (state: number) => void
  onError?: (err: { code?: number; message: string }) => void
  onRemoteClipboard?: (text: string) => void
  onMetrics?: (m: RDPMetrics) => void
  onViewportChange?: (v: RDPViewportState) => void
}

// Plugin registration token — the orchestrator hands one to each plugin so it
// can read live state and request side effects (record, snapshot, etc.).
export interface RDPPluginContext {
  // Returns the host DIV the client is mounted in.
  getHost(): HTMLElement
  // Pixi application; plugins add display objects to its stage.
  getPixiApp(): unknown
  // The HTMLCanvasElement Pixi renders to. Stream / screenshot targets.
  // After Plan 16's architecture flip this canvas is transparent — only
  // annotations live on it. Use getDisplayElement() to get at the Guac
  // canvases for compositing the actual desktop frame.
  getRenderCanvas(): HTMLCanvasElement
  // Plan 16.A.3 — the Guacamole display container holding all desktop
  // canvases (default layer, cursor layer, intermediate buffers). compose.ts
  // walks these to build screenshots and recording frames.
  getDisplayElement(): HTMLElement | null
  // Plan 16.B — remote desktop dimensions in pixels (updated on resize).
  // Needed by compose() to size the offscreen capture canvas.
  getRemoteSize(): { w: number; h: number }
  // Capture the current frame including any plugin overlays.
  snapshot(): Promise<Blob>
  // Subscribe to remote desktop size changes.
  onRemoteResize(cb: (w: number, h: number) => void): () => void
}

export interface RDPPlugin {
  name: string
  init(ctx: RDPPluginContext): Promise<void> | void
  destroy(): Promise<void> | void
}
