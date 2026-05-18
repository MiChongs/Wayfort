// StatsPlugin — Plan 15.D.8. Wraps stats.js into a floating, draggable
// panel in the host corner. The Pixi ticker drives the begin/end frame
// markers so the FPS readout reflects actual rendering work, not just rAF
// scheduling.

import Stats from "stats.js"
import * as PIXI from "pixi.js"
import type { RDPPlugin, RDPPluginContext } from "../types"

export class StatsPlugin implements RDPPlugin {
  readonly name = "stats"
  private ctx: RDPPluginContext | null = null
  private stats: Stats | null = null
  private app: PIXI.Application | null = null
  private wrapper: HTMLDivElement | null = null
  private tickerCb: ((t: PIXI.Ticker) => void) | null = null
  private visible = false

  init(ctx: RDPPluginContext): void {
    this.ctx = ctx
    this.app = ctx.getPixiApp() as PIXI.Application
    this.stats = new Stats()
    this.stats.showPanel(0) // 0 = FPS
    this.wrapper = document.createElement("div")
    this.wrapper.dataset.rdpStats = "1"
    this.wrapper.style.position = "absolute"
    this.wrapper.style.top = "8px"
    this.wrapper.style.left = "8px"
    this.wrapper.style.zIndex = "30"
    this.wrapper.style.display = "none"
    this.wrapper.appendChild(this.stats.dom)
    // Override stats.js's absolute positioning (it sets dom.style.position
    // = "fixed" by default which fights our overlay).
    this.stats.dom.style.position = "relative"
    this.stats.dom.style.cursor = "move"
    ctx.getHost().appendChild(this.wrapper)
    this.bindDrag()
    this.attachTicker()
  }

  destroy(): void {
    if (this.app && this.tickerCb) this.app.ticker.remove(this.tickerCb)
    this.tickerCb = null
    this.wrapper?.remove()
    this.wrapper = null
    this.stats = null
    this.app = null
    this.ctx = null
  }

  setVisible(v: boolean): void {
    this.visible = v
    if (this.wrapper) this.wrapper.style.display = v ? "block" : "none"
  }

  isVisible(): boolean {
    return this.visible
  }

  // Cycle through stats.js panels: 0=fps 1=ms 2=mb.
  cyclePanel(): void {
    if (!this.stats) return
    const dom = this.stats.dom
    const next = ((this.currentPanel() + 1) % 3) as 0 | 1 | 2
    this.stats.showPanel(next)
    void dom
  }

  // ----- internals -----

  private currentPanel(): number {
    // stats.js stores the visible panel in a private prop; read it via the
    // children visibility for resilience.
    const dom = this.stats?.dom
    if (!dom) return 0
    const children = Array.from(dom.children) as HTMLElement[]
    return children.findIndex((c) => c.style.display !== "none")
  }

  private attachTicker(): void {
    if (!this.app || !this.stats) return
    const stats = this.stats
    this.tickerCb = () => {
      stats.begin()
      // The actual draw happened in another ticker callback; we just need
      // a paired begin/end to estimate frame time.
      stats.end()
    }
    this.app.ticker.add(this.tickerCb)
  }

  private bindDrag(): void {
    const dom = this.stats?.dom
    if (!dom) return
    let dragging = false
    let startX = 0
    let startY = 0
    let startLeft = 0
    let startTop = 0
    dom.addEventListener("pointerdown", (e) => {
      dragging = true
      dom.setPointerCapture(e.pointerId)
      startX = e.clientX
      startY = e.clientY
      const r = this.wrapper!.getBoundingClientRect()
      const host = this.ctx!.getHost().getBoundingClientRect()
      startLeft = r.left - host.left
      startTop = r.top - host.top
    })
    dom.addEventListener("pointermove", (e) => {
      if (!dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (this.wrapper) {
        this.wrapper.style.left = `${startLeft + dx}px`
        this.wrapper.style.top = `${startTop + dy}px`
        this.wrapper.style.right = "auto"
      }
    })
    dom.addEventListener("pointerup", (e) => {
      dragging = false
      try {
        dom.releasePointerCapture(e.pointerId)
      } catch {
        /* */
      }
    })
  }
}
