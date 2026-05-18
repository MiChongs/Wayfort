// Viewport — Fit/Fill/1:1 modes + interactive zoom/pan with momentum.
//
// We drive the visual transform on TWO surfaces in lockstep:
//   1. The Pixi stage (compositor.applyHostTransform) — actual rendering.
//   2. The Guacamole hidden input element (CSS transform) — so the browser's
//      getBoundingClientRect math used by Guacamole.Mouse keeps coordinates
//      in remote-pixel space without any manual translation.
//
// Persistence: per (nodeID) viewport state stored in localStorage so
// re-opening a session restores the user's preferred zoom & pan.

import type { PixiCompositor } from "./compositor"
import type { RDPViewportMode, RDPViewportState } from "./types"

const STORAGE_KEY = "rdp:viewport"
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4.0
const ZOOM_STEP = 1.15

export interface ViewportDeps {
  // Container the viewport applies to.
  host: HTMLElement
  // Pixi renderer — handles its own coordinate system.
  compositor: PixiCompositor
  // The Guacamole-owned wrapper holding the hidden canvas — receives a CSS
  // transform so input coords map back to remote pixels.
  inputElement: HTMLElement
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

  pan(dx: number, dy: number): void {
    this.state.offsetX += dx
    this.state.offsetY += dy
    this.apply()
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
    this.deps.compositor.applyHostTransform(
      this.state.scale,
      this.state.offsetX,
      this.state.offsetY,
    )
    // Mirror the same transform to the hidden Guacamole element so its
    // getBoundingClientRect-based mouse coords remain in remote-pixel space.
    // The hidden element's intrinsic size is the remote desktop size; the
    // transform scales it visually (no effect since opacity:0) but the
    // bounding rect that Guacamole.Mouse reads now matches what we drew.
    this.deps.inputElement.style.transformOrigin = "0 0"
    this.deps.inputElement.style.transform =
      `translate(${this.state.offsetX}px, ${this.state.offsetY}px) scale(${this.state.scale})`
    this.deps.inputElement.style.width = `${this.state.remoteWidth}px`
    this.deps.inputElement.style.height = `${this.state.remoteHeight}px`
    this.deps.onChange?.(this.state)
  }

  private bindInteractions(): void {
    const host = this.deps.host
    // Ctrl-wheel zoom. We attach to the host because the Pixi canvas has
    // pointer-events:none and we don't want to consume Guac's mouse events.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP
      const rect = host.getBoundingClientRect()
      this.zoom(factor, e.clientX - rect.left, e.clientY - rect.top)
    }
    host.addEventListener("wheel", onWheel, { passive: false })
    this.cleanup.push(() => host.removeEventListener("wheel", onWheel))

    // Middle-mouse pan. Capture on the host so we get events before they
    // reach the (transparent) Guac element.
    let panning = false
    let lastX = 0
    let lastY = 0
    let lastTime = 0
    let velX = 0
    let velY = 0
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return // middle only
      e.preventDefault()
      panning = true
      lastX = e.clientX
      lastY = e.clientY
      lastTime = performance.now()
      velX = 0
      velY = 0
      if (this.momentumRAF != null) {
        cancelAnimationFrame(this.momentumRAF)
        this.momentumRAF = null
      }
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!panning) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      const now = performance.now()
      const dt = Math.max(1, now - lastTime)
      velX = dx / dt
      velY = dy / dt
      lastX = e.clientX
      lastY = e.clientY
      lastTime = now
      this.pan(dx, dy)
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 1) return
      panning = false
      // Momentum: decay velocity over ~500ms (damping each frame).
      this.startMomentum(velX, velY)
    }
    host.addEventListener("mousedown", onMouseDown, true)
    host.addEventListener("mousemove", onMouseMove, true)
    host.addEventListener("mouseup", onMouseUp, true)
    this.cleanup.push(() => {
      host.removeEventListener("mousedown", onMouseDown, true)
      host.removeEventListener("mousemove", onMouseMove, true)
      host.removeEventListener("mouseup", onMouseUp, true)
    })

    // Double-click toggles Fit ↔ 1:1.
    const onDblClick = (e: MouseEvent) => {
      if (e.button !== 0) return
      this.setMode(this.state.mode === "fit" ? "actual" : "fit")
    }
    host.addEventListener("dblclick", onDblClick)
    this.cleanup.push(() => host.removeEventListener("dblclick", onDblClick))
  }

  private startMomentum(vx: number, vy: number): void {
    // Skip tiny flicks.
    if (Math.abs(vx) < 0.1 && Math.abs(vy) < 0.1) return
    const decay = 0.92
    const tick = () => {
      vx *= decay
      vy *= decay
      // Per-frame translation (assume 60Hz).
      this.pan(vx * 16, vy * 16)
      if (Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) {
        this.momentumRAF = null
        return
      }
      this.momentumRAF = requestAnimationFrame(tick)
    }
    this.momentumRAF = requestAnimationFrame(tick)
  }

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
