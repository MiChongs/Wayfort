// RDPClient — Plan 15 orchestrator.
//
// Public API mirrors connectGuacamole() so React/use-rdp can stay simple. The
// difference: instead of letting Guacamole.Client own the visible canvas,
// we mount our PixiCompositor as the visible surface, hide Guacamole's
// display element with InputBridge, and rebind input. The Viewport drives
// matched transforms on both so coordinates stay aligned.
//
// Lifecycle:
//   1. ensureGuacamoleScript() loads /vendor/guacamole-common.min.js
//   2. Compositor.init() boots Pixi + WebGL
//   3. WebSocketTunnel opens; Client connects
//   4. On Display ready: attach Guac canvas to compositor; bind inputs
//   5. Viewport begins responding to wheel/drag/resize
//   6. Plugins (recording / screenshot / annotation / minimap / stats) attach

import { ensureGuacamoleScript, type GuacQuality } from "@/lib/ws/guacamole-client"
import { getAccessToken } from "@/lib/auth/tokens"
import { composeFrame } from "./compose"
import { PixiCompositor } from "./compositor"
import { InputBridge } from "./input-bridge"
import { Viewport } from "./viewport"
import type {
  RDPClientOptions,
  RDPMetrics,
  RDPPlugin,
  RDPPluginContext,
  RDPViewportState,
} from "./types"

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"

const KEYSYMS = { Ctrl: 0xffe3, Alt: 0xffe9, Delete: 0xffff }

interface GuacClient {
  onerror?: (s: { code?: number; message?: string }) => void
  onstatechange?: (s: number) => void
  onclipboard?: (stream: unknown, mimetype: string) => void
  onsync?: (timestamp: number) => void
  getDisplay(): GuacDisplayCtl
  sendMouseState(s: unknown): void
  sendKeyEvent(p: number, k: number): void
  sendSize(w: number, h: number): void
  createClipboardStream?: (mimetype: string) => unknown
  connect(query: string): void
  disconnect(): void
}

interface GuacDisplayCtl {
  getElement(): HTMLElement
  onresize?: (w: number, h: number) => void
  // Plan 16: scale() is the library-native zoom hook the Viewport drives.
  scale?: (s: number) => void
  getDefaultLayer?: () => { getCanvas?: () => HTMLCanvasElement }
}

interface GuacTunnel {
  oninstruction?: (op: string, args: string[]) => void
  onerror?: (s: { code?: number; message?: string }) => void
  onstatechange?: (s: number) => void
  disconnect?: () => void
}

interface GuacNS {
  Client: new (tunnel: unknown) => GuacClient
  WebSocketTunnel: new (url: string) => GuacTunnel
  Mouse: new (el: HTMLElement) => unknown
  Keyboard: new (target: Document | HTMLElement) => unknown
  Touch?: new (el: HTMLElement) => unknown
  StringReader?: new (stream: unknown) => { ontext?: (t: string) => void; onend?: () => void }
  StringWriter?: new (stream: unknown) => { sendText(t: string): void; sendEnd(): void }
}

export class RDPClient {
  private opts: RDPClientOptions
  private compositor = new PixiCompositor()
  private viewport: Viewport | null = null
  private bridge: InputBridge | null = null
  private tunnel: GuacTunnel | null = null
  private client: GuacClient | null = null
  private plugins: RDPPlugin[] = []
  private destroyed = false
  // Metrics counters mirrored from the old wrapper (Plan 13).
  private lastSyncAt = Date.now()
  private bytesInTotal = 0
  private bytesInSinceTick = 0
  private instructionsSinceTick = 0
  private metricsTimer: number | null = null
  private fpsSamples: number[] = []
  private remoteResizeSubs: Array<(w: number, h: number) => void> = []
  // Plan 16: Guacamole's display container — composite/screenshot/recording
  // walk its child canvases to build a single frame.
  private guacDisplayEl: HTMLElement | null = null
  private remoteSize = { w: 1280, h: 720 }

  constructor(opts: RDPClientOptions) {
    this.opts = opts
  }

  async connect(): Promise<void> {
    const G = (await ensureGuacamoleScript()) as unknown as GuacNS
    if (this.destroyed) return

    await this.compositor.init({ host: this.opts.host })
    if (this.destroyed) return

    const url = this.buildURL()
    const tunnel = new G.WebSocketTunnel(url)
    this.tunnel = tunnel
    tunnel.onerror = (s) =>
      this.opts.onError?.({
        code: s?.code,
        message: s?.message || `tunnel error (code=${s?.code ?? "?"})`,
      })

    const client = new G.Client(tunnel)
    this.client = client
    client.onerror = (s) =>
      this.opts.onError?.({
        code: s?.code,
        message: s?.message || `guac error (code=${s?.code ?? "?"})`,
      })
    client.onstatechange = (s) => this.opts.onStateChange?.(s)
    client.onsync = () => {
      this.lastSyncAt = Date.now()
    }
    client.onclipboard = (stream, mimetype) => {
      if (!mimetype?.startsWith("text/") || !G.StringReader) return
      const reader = new G.StringReader(stream)
      let acc = ""
      reader.ontext = (t: string) => {
        acc += t
      }
      reader.onend = () => {
        if (acc) this.opts.onRemoteClipboard?.(acc)
      }
    }

    // Count protocol activity for bandwidth + instruction rate. Chain so we
    // don't clobber Guacamole.Client's own oninstruction listener.
    const origInstruction = tunnel.oninstruction
    tunnel.oninstruction = (op, args) => {
      const size = op.length + args.reduce((s, a) => s + a.length, 0)
      this.bytesInSinceTick += size
      this.bytesInTotal += size
      this.instructionsSinceTick++
      origInstruction?.(op, args)
    }

    // Plan 16: Guacamole owns the visible surface. We grab the display
    // controller + element, subscribe to remote-size changes (so the
    // viewport / plugins know intrinsic dimensions), and let the library
    // do all the drawing including the cursor layer.
    const displayCtl = client.getDisplay()
    const displayEl = displayCtl.getElement()
    this.guacDisplayEl = displayEl
    displayCtl.onresize = (w: number, h: number) => {
      this.remoteSize = { w, h }
      this.viewport?.setRemoteSize(w, h)
      for (const cb of this.remoteResizeSubs) cb(w, h)
    }

    // Mount the visible Guac display via the input bridge. Wrapper now has
    // opacity:1 and centres the desktop in the host.
    this.bridge = new InputBridge({
      host: this.opts.host,
      guacDisplayElement: displayEl,
      ctors: G,
      client,
    })

    // Viewport drives Guacamole.Display.scale() — single source of truth
    // for zoom; cursor + buffers follow automatically.
    this.viewport = new Viewport({
      host: this.opts.host,
      guacDisplay: displayCtl,
      onChange: (v: RDPViewportState) => this.opts.onViewportChange?.(v),
    })
    this.viewport.attach(this.opts.nodeId)

    // Init any pre-registered plugins now that everything is ready.
    const ctx = this.makePluginContext()
    for (const p of this.plugins) {
      await p.init(ctx)
    }

    this.startMetricsTimer()
    this.measureFPS()

    try {
      client.connect(`width=1280&height=720&dpi=96&audio=audio/L16;rate=44100,channels=2`)
    } catch (e) {
      this.opts.onError?.({ message: `client.connect 异常: ${(e as Error).message}` })
      throw e
    }
  }

  // Register a plugin. If the client is already connected, the plugin is
  // init()'d immediately.
  use(plugin: RDPPlugin): void {
    this.plugins.push(plugin)
    if (this.client && this.viewport) {
      void plugin.init(this.makePluginContext())
    }
  }

  // ----- imperative controls used by the toolbar -----

  sendCtrlAltDel(): void {
    if (!this.client) return
    const seq: Array<[number, number]> = [
      [1, KEYSYMS.Ctrl],
      [1, KEYSYMS.Alt],
      [1, KEYSYMS.Delete],
      [0, KEYSYMS.Delete],
      [0, KEYSYMS.Alt],
      [0, KEYSYMS.Ctrl],
    ]
    for (const [p, k] of seq) this.client.sendKeyEvent(p, k)
  }

  pushClipboard(text: string): void {
    if (!this.client || !text) return
    const G = (window as unknown as { Guacamole?: GuacNS }).Guacamole
    if (!G?.StringWriter || !this.client.createClipboardStream) return
    try {
      const stream = this.client.createClipboardStream("text/plain")
      if (!stream) return
      const writer = new G.StringWriter(stream)
      writer.sendText(text)
      writer.sendEnd()
    } catch {
      /* */
    }
  }

  // ----- viewport facade -----

  zoom(factor: number): void {
    this.viewport?.zoom(factor)
  }
  setViewportMode(mode: "fit" | "fill" | "actual"): void {
    this.viewport?.setMode(mode)
  }
  getViewport(): RDPViewportState | null {
    return this.viewport?.current ?? null
  }

  // Plan 16: snapshot composites Guacamole's child canvases (background +
  // cursor + buffers) plus the Pixi overlay (annotations) into one PNG.
  async snapshot(): Promise<Blob> {
    if (!this.guacDisplayEl) throw new Error("snapshot: display not ready")
    let overlay: HTMLCanvasElement | null = null
    try {
      overlay = this.compositor.getRenderCanvas()
    } catch {
      overlay = null
    }
    const canvas = composeFrame({
      displayEl: this.guacDisplayEl,
      overlayCanvas: overlay,
      remoteW: this.remoteSize.w,
      remoteH: this.remoteSize.h,
    })
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("snapshot blob null"))), "image/png")
    })
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    if (this.metricsTimer != null) {
      window.clearInterval(this.metricsTimer)
      this.metricsTimer = null
    }
    for (const p of [...this.plugins].reverse()) {
      try {
        await p.destroy()
      } catch {
        /* */
      }
    }
    this.plugins = []
    this.viewport?.destroy()
    this.viewport = null
    this.bridge?.destroy()
    this.bridge = null
    try {
      this.client?.disconnect()
    } catch {
      /* */
    }
    try {
      this.tunnel?.disconnect?.()
    } catch {
      /* */
    }
    this.client = null
    this.tunnel = null
    this.compositor.destroy()
  }

  // ----- internals -----

  private buildURL(): string {
    const token = getAccessToken() ?? ""
    const params = new URLSearchParams({
      token,
      width: "1280",
      height: "720",
      dpi: "96",
    })
    if (this.opts.quality) params.set("quality", this.opts.quality)
    if (this.opts.enableAudio !== undefined)
      params.set("audio", this.opts.enableAudio ? "1" : "0")
    if (this.opts.enableClipboard !== undefined)
      params.set("clipboard", this.opts.enableClipboard ? "1" : "0")
    if (this.opts.keyboardLayout) params.set("keyboard", this.opts.keyboardLayout)
    return `${WS_BASE}/api/v1/ws/${this.opts.protocol}/${this.opts.nodeId}?${params.toString()}`
  }

  private startMetricsTimer(): void {
    if (!this.opts.onMetrics) return
    this.metricsTimer = window.setInterval(() => {
      const now = Date.now()
      const lastSyncAgeMs = now - this.lastSyncAt
      const fps = this.computeFPS()
      const heap = this.readHeap()
      const m: RDPMetrics = {
        lastSyncAgeMs,
        bytesPerSecIn: this.bytesInSinceTick,
        bytesIn: this.bytesInTotal,
        fps,
        instructionsPerSec: this.instructionsSinceTick,
        jsHeapMb: heap,
      }
      this.bytesInSinceTick = 0
      this.instructionsSinceTick = 0
      this.opts.onMetrics?.(m)
    }, 1000)
  }

  private measureFPS(): void {
    // Sample frame timestamps via rAF; computeFPS averages the last 60.
    const tick = (t: number) => {
      if (this.destroyed) return
      this.fpsSamples.push(t)
      if (this.fpsSamples.length > 120) this.fpsSamples.shift()
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private computeFPS(): number | undefined {
    if (this.fpsSamples.length < 2) return undefined
    const oldest = this.fpsSamples[0]
    const newest = this.fpsSamples[this.fpsSamples.length - 1]
    const span = (newest - oldest) / 1000
    if (span <= 0) return undefined
    return (this.fpsSamples.length - 1) / span
  }

  private readHeap(): number | undefined {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } }
    if (!perf.memory) return undefined
    return Math.round(perf.memory.usedJSHeapSize / (1024 * 1024))
  }

  private makePluginContext(): RDPPluginContext {
    return {
      getHost: () => this.opts.host,
      getPixiApp: () => this.compositor.getApp(),
      getRenderCanvas: () => this.compositor.getRenderCanvas(),
      getDisplayElement: () => this.guacDisplayEl,
      getRemoteSize: () => this.remoteSize,
      snapshot: () => this.snapshot(),
      onRemoteResize: (cb) => {
        this.remoteResizeSubs.push(cb)
        return () => {
          this.remoteResizeSubs = this.remoteResizeSubs.filter((x) => x !== cb)
        }
      },
    }
  }
}

// Convenience factory matching the old connectGuacamole() shape so the React
// surface can swap minimally.
export async function connectRDP(opts: RDPClientOptions): Promise<RDPClient> {
  const c = new RDPClient(opts)
  await c.connect()
  return c
}

// Re-export the GuacQuality type so callers don't pull from two places.
export type { GuacQuality }
