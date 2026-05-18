// MinimapPlugin — Plan 15.D.7. A small thumbnail of the remote desktop in
// the bottom-right corner with a highlighted viewport rectangle. Click
// anywhere on the minimap to teleport the viewport centre.
//
// Implemented as a separate <canvas> overlay (NOT a Pixi container on the
// main stage) so it doesn't get baked into screenshots / recordings — a
// minimap inside the captured frame would look weird.

import type { RDPPlugin, RDPPluginContext } from "../types"

const MINIMAP_WIDTH = 200
const MINIMAP_HEIGHT = 120

export interface MinimapState {
  visible: boolean
}

export interface MinimapDeps {
  // Called when the user clicks a point on the minimap; coordinates are
  // remote-pixel space. The RDP client should pan the viewport so that
  // remote pixel (x, y) appears at the visible-host centre.
  onTeleport(x: number, y: number): void
  // Reads the host-visible rect (CSS px) and current stage transform so
  // we can draw a viewport box.
  getViewport(): { hostW: number; hostH: number; scale: number; offsetX: number; offsetY: number }
  // Remote desktop dimensions (initial; updated on remote resize).
  getRemoteSize(): { w: number; h: number }
}

export class MinimapPlugin implements RDPPlugin {
  readonly name = "minimap"
  private ctx: RDPPluginContext | null = null
  private canvas: HTMLCanvasElement | null = null
  private wrapper: HTMLDivElement | null = null
  private rafId: number | null = null
  private visible = true
  private hostRect: { w: number; h: number } = { w: 0, h: 0 }
  private unsubResize: (() => void) | null = null

  constructor(private deps: MinimapDeps) {}

  init(ctx: RDPPluginContext): void {
    this.ctx = ctx
    const host = ctx.getHost()
    const wrapper = document.createElement("div")
    wrapper.dataset.rdpMinimap = "1"
    wrapper.style.position = "absolute"
    wrapper.style.right = "12px"
    wrapper.style.bottom = "12px"
    wrapper.style.width = `${MINIMAP_WIDTH}px`
    wrapper.style.height = `${MINIMAP_HEIGHT}px`
    wrapper.style.border = "1px solid rgba(255,255,255,0.25)"
    wrapper.style.borderRadius = "6px"
    wrapper.style.background = "rgba(0,0,0,0.55)"
    wrapper.style.backdropFilter = "blur(6px)"
    wrapper.style.cursor = "pointer"
    wrapper.style.zIndex = "30"
    wrapper.style.overflow = "hidden"
    const c = document.createElement("canvas")
    c.width = MINIMAP_WIDTH
    c.height = MINIMAP_HEIGHT
    c.style.width = "100%"
    c.style.height = "100%"
    wrapper.appendChild(c)
    host.appendChild(wrapper)
    this.wrapper = wrapper
    this.canvas = c
    this.unsubResize = ctx.onRemoteResize(() => {
      // Will be picked up automatically on the next animation frame via
      // getRemoteSize() in the deps. Nothing to do here right now.
    })
    this.bindClick()
    this.scheduleNextFrame()
  }

  destroy(): void {
    if (this.rafId != null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    this.unsubResize?.()
    this.unsubResize = null
    if (this.wrapper) this.wrapper.remove()
    this.wrapper = null
    this.canvas = null
    this.ctx = null
  }

  setVisible(v: boolean): void {
    this.visible = v
    if (this.wrapper) this.wrapper.style.display = v ? "block" : "none"
  }

  isVisible(): boolean {
    return this.visible
  }

  // ----- internals -----

  private bindClick(): void {
    if (!this.wrapper) return
    this.wrapper.addEventListener("click", (e) => {
      const remote = this.deps.getRemoteSize()
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const fracX = (e.clientX - rect.left) / rect.width
      const fracY = (e.clientY - rect.top) / rect.height
      this.deps.onTeleport(fracX * remote.w, fracY * remote.h)
    })
  }

  private scheduleNextFrame(): void {
    const tick = () => {
      this.render()
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private render(): void {
    if (!this.canvas || !this.ctx || !this.visible) return
    const remote = this.deps.getRemoteSize()
    if (remote.w <= 0 || remote.h <= 0) return
    const c = this.canvas.getContext("2d")
    if (!c) return
    // Pull the host rect each frame in case the user resized the panel.
    const host = this.ctx.getHost()
    this.hostRect = { w: host.clientWidth, h: host.clientHeight }

    c.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT)
    // Plan 16: source is the Guac display element's largest child canvas
    // (background layer). Pixi canvas (overlay) is mostly transparent and
    // useless here. We don't need the cursor in the minimap.
    const displayEl = this.ctx.getDisplayElement?.()
    const src = pickBackgroundCanvas(displayEl)
    const fit = Math.min(MINIMAP_WIDTH / remote.w, MINIMAP_HEIGHT / remote.h)
    const w = remote.w * fit
    const h = remote.h * fit
    const ox = (MINIMAP_WIDTH - w) / 2
    const oy = (MINIMAP_HEIGHT - h) / 2
    if (src) {
      try {
        c.drawImage(src, ox, oy, w, h)
      } catch {
        /* Tainted or cross-origin — ignore */
      }
    }
    // Viewport rectangle in remote space → minimap space.
    const vp = this.deps.getViewport()
    if (vp.scale > 0) {
      const visibleW = vp.hostW / vp.scale
      const visibleH = vp.hostH / vp.scale
      const visibleX = -vp.offsetX / vp.scale
      const visibleY = -vp.offsetY / vp.scale
      const rx = ox + visibleX * fit
      const ry = oy + visibleY * fit
      const rw = visibleW * fit
      const rh = visibleH * fit
      c.strokeStyle = "rgba(96, 165, 250, 0.9)"
      c.lineWidth = 1.5
      c.strokeRect(
        clamp(rx, ox, ox + w),
        clamp(ry, oy, oy + h),
        Math.min(rw, w),
        Math.min(rh, h),
      )
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// Pick the largest <canvas> child of the Guac display element — that's
// almost always the background layer. We skip the cursor (small) and any
// intermediate buffer canvases by area-sorting.
function pickBackgroundCanvas(displayEl: HTMLElement | null | undefined): HTMLCanvasElement | null {
  if (!displayEl) return null
  let best: HTMLCanvasElement | null = null
  let bestArea = 0
  const all = displayEl.querySelectorAll<HTMLCanvasElement>("canvas")
  for (const c of all) {
    const a = c.width * c.height
    if (a > bestArea) {
      bestArea = a
      best = c
    }
  }
  return best
}
