// Viewport — Fit/Fill/1:1 modes + interactive zoom with momentum (pan kept
// for follow-up; with Guacamole.Display.scale() the library auto-positions
// the desktop in the centred wrapper).
//
// After Plan 16 we drive zoom via Guacamole.Display.scale(s) — the library
// propagates the scale to every child canvas (background + cursor + buffers)
// and adjusts mouse coordinates internally so we don't have to. No CSS
// transform math on our end.

import type { RDPViewportMode, RDPViewportState } from "./types"

interface GuacDisplay {
  scale?: (s: number) => void
}

const STORAGE_KEY = "rdp:viewport"
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4.0
const ZOOM_STEP = 1.15

export interface ViewportDeps {
  // Container the viewport applies to.
  host: HTMLElement
  // Guacamole's display controller — gets scale() calls.
  guacDisplay: GuacDisplay
  // Optional change subscriber.
  onChange?: (state: RDPViewportState) => void
}

export class Viewport {
  private state: RDPViewportState = {
    mode: "fit",
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    remoteWidth: 1280,
    remoteHeight: 720,
  }
  private nodeKey = ""
  private resizeObserver: ResizeObserver | null = null
  private cleanup: Array<() => void> = []
  private momentumRAF: number | null = null

  constructor(private deps: ViewportDeps) {}

  attach(nodeId: number): void {
    this.nodeKey = `${STORAGE_KEY}:${nodeId}`
    this.restore()
    this.bindInteractions()
    this.resizeObserver = new ResizeObserver(() => this.relayout())
    this.resizeObserver.observe(this.deps.host)
  }

  destroy(): void {
    if (this.momentumRAF != null) cancelAnimationFrame(this.momentumRAF)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    for (const c of this.cleanup) c()
    this.cleanup = []
  }

  // Called when guacd reports a new remote desktop size (Display.onresize).
  setRemoteSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    if (width === this.state.remoteWidth && height === this.state.remoteHeight) return
    this.state.remoteWidth = width
    this.state.remoteHeight = height
    this.relayout()
  }

  setMode(mode: RDPViewportMode): void {
    this.state.mode = mode
    this.relayout()
    this.persist()
  }

  // User-driven zoom (toolbar buttons / Ctrl-wheel). Anchored at the host
  // centre so visual focus is preserved.
  zoom(factor: number, anchorX?: number, anchorY?: number): void {
    const rect = this.deps.host.getBoundingClientRect()
    const ax = anchorX ?? rect.width / 2
    const ay = anchorY ?? rect.height / 2
    const newScale = clamp(this.state.scale * factor, MIN_ZOOM, MAX_ZOOM)
    if (newScale === this.state.scale) return
    // Pin the anchor point under the cursor:
    // newOffset = anchor - (anchor - oldOffset) * (newScale / oldScale)
    const ratio = newScale / this.state.scale
    this.state.offsetX = ax - (ax - this.state.offsetX) * ratio
    this.state.offsetY = ay - (ay - this.state.offsetY) * ratio
    this.state.scale = newScale
    this.state.mode = "actual" // free-form zoom escapes Fit/Fill
    this.apply()
    this.persist()
  }

  // Plan 16: pan is a no-op now. Guacamole's display is auto-centred by the
  // wrapper flex layout; "pan" would have meant CSS-translating the wrapper,
  // which conflicts with the centring. Kept as a stub so existing callers
  // (and the minimap teleport stub) don't break.
  pan(_dx: number, _dy: number): void {
    /* intentionally empty */
  }

  reset(): void {
    this.setMode("fit")
  }

  get current(): Readonly<RDPViewportState> {
    return this.state
  }

  // ----- internals -----

  private relayout(): void {
    if (this.state.mode === "fit" || this.state.mode === "fill") {
      const rect = this.deps.host.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const sx = rect.width / this.state.remoteWidth
      const sy = rect.height / this.state.remoteHeight
      this.state.scale =
        this.state.mode === "fit" ? Math.min(sx, sy) : Math.max(sx, sy)
      const w = this.state.remoteWidth * this.state.scale
      const h = this.state.remoteHeight * this.state.scale
      this.state.offsetX = (rect.width - w) / 2
      this.state.offsetY = (rect.height - h) / 2
    }
    this.apply()
  }

  private apply(): void {
    // Drive Guacamole's own scaling. The library updates every child
    // canvas (background + cursor + buffers) and shifts its internal
    // coordinate transforms so Mouse continues to report remote pixels.
    try {
      this.deps.guacDisplay.scale?.(this.state.scale)
    } catch {
      /* old library versions might throw on extreme values; fail soft */
    }
    this.deps.onChange?.(this.state)
  }

  private bindInteractions(): void {
    const host = this.deps.host
    // Plan 16: only Ctrl-wheel zoom is bound here. Middle-mouse pan was
    // dropped because Guacamole now owns the visible canvas (no manual
    // panning needed — Guac centres itself in the wrapper) and middle
    // clicks have semantic meaning to many remote shells (paste etc.).
    // Double-click was dropped because users double-click files on the
    // remote desktop frequently and a viewport-mode flip would surprise.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP
      const rect = host.getBoundingClientRect()
      this.zoom(factor, e.clientX - rect.left, e.clientY - rect.top)
    }
    host.addEventListener("wheel", onWheel, { passive: false })
    this.cleanup.push(() => host.removeEventListener("wheel", onWheel))
  }

  // momentum scrolling is no-op in Plan 16 — pan is gone.

  private restore(): void {
    if (typeof window === "undefined") return
    try {
      const raw = window.localStorage.getItem(this.nodeKey)
      if (!raw) return
      const v = JSON.parse(raw) as Partial<RDPViewportState>
      if (v.mode) this.state.mode = v.mode
      // Don't restore actual-mode zoom/pan — too easy to land in a weird
      // place after a remote resolution change. Mode preference is enough.
    } catch {
      /* */
    }
  }

  private persist(): void {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(
        this.nodeKey,
        JSON.stringify({ mode: this.state.mode }),
      )
    } catch {
      /* quota */
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
