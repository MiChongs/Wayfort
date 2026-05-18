// AnnotationPlugin — Plan 15.D.6. A Pixi Graphics overlay that lets users
// draw freehand strokes / arrows / rectangles on top of the remote desktop.
// Strokes are local-only (never sent to the remote) and are baked into
// screenshots + recordings because they live on the same Pixi stage.

import * as PIXI from "pixi.js"
import type { RDPPlugin, RDPPluginContext } from "../types"

export type AnnotationTool = "pen" | "arrow" | "rectangle" | "highlight"

export interface AnnotationStyle {
  color: number
  width: number
  alpha: number
}

interface Stroke {
  graphics: PIXI.Graphics
  tool: AnnotationTool
  points: { x: number; y: number }[]
  style: AnnotationStyle
}

export class AnnotationPlugin implements RDPPlugin {
  readonly name = "annotation"
  private ctx: RDPPluginContext | null = null
  private container: PIXI.Container | null = null
  private app: PIXI.Application | null = null
  private host: HTMLElement | null = null
  private strokes: Stroke[] = []
  private undone: Stroke[] = []
  private current: Stroke | null = null
  private enabled = false
  private tool: AnnotationTool = "pen"
  private style: AnnotationStyle = { color: 0xef4444, width: 3, alpha: 0.9 }
  private hostListeners: Array<() => void> = []

  init(ctx: RDPPluginContext): void {
    this.ctx = ctx
    this.app = ctx.getPixiApp() as PIXI.Application
    this.host = ctx.getHost()
    this.container = new PIXI.Container()
    // Bring to top — annotations should render above the remote sprite.
    this.container.zIndex = 100
    this.app.stage.sortableChildren = true
    this.app.stage.addChild(this.container)
  }

  destroy(): void {
    this.disableInputs()
    if (this.container) {
      this.container.destroy({ children: true })
    }
    this.container = null
    this.app = null
    this.host = null
    this.strokes = []
    this.undone = []
    this.current = null
    this.ctx = null
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.enableInputs()
    } else {
      this.disableInputs()
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setTool(tool: AnnotationTool): void {
    this.tool = tool
  }

  setStyle(style: Partial<AnnotationStyle>): void {
    this.style = { ...this.style, ...style }
  }

  clear(): void {
    if (!this.container) return
    for (const s of this.strokes) s.graphics.destroy()
    this.strokes = []
    this.undone = []
    this.container.removeChildren()
  }

  undo(): void {
    const last = this.strokes.pop()
    if (!last || !this.container) return
    this.container.removeChild(last.graphics)
    this.undone.push(last)
  }

  redo(): void {
    const next = this.undone.pop()
    if (!next || !this.container) return
    this.strokes.push(next)
    this.container.addChild(next.graphics)
  }

  // ----- input wiring -----

  private enableInputs(): void {
    if (!this.host) return
    // Make the Pixi canvas top-most & event-receiving while we're drawing.
    // We do this with a small overlay div so we don't have to fight Guac's
    // own pointer-events styling.
    const overlay = document.createElement("div")
    overlay.dataset.rdpAnnotationOverlay = "1"
    overlay.style.position = "absolute"
    overlay.style.inset = "0"
    overlay.style.zIndex = "5"
    overlay.style.cursor = "crosshair"
    overlay.style.touchAction = "none"
    this.host.appendChild(overlay)

    const toLocal = (e: PointerEvent): { x: number; y: number } => {
      const rect = overlay.getBoundingClientRect()
      // Account for the stage transform applied by Viewport so strokes
      // land in remote-pixel space (and stay aligned when the user later
      // pans/zooms).
      const stage = this.app?.stage
      const scale = stage?.scale?.x ?? 1
      const tx = stage?.position?.x ?? 0
      const ty = stage?.position?.y ?? 0
      const x = (e.clientX - rect.left - tx) / scale
      const y = (e.clientY - rect.top - ty) / scale
      return { x, y }
    }

    const down = (e: PointerEvent) => {
      e.preventDefault()
      this.beginStroke(toLocal(e))
      overlay.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!this.current) return
      this.extendStroke(toLocal(e))
    }
    const up = (e: PointerEvent) => {
      if (this.current) this.endStroke(toLocal(e))
      try {
        overlay.releasePointerCapture(e.pointerId)
      } catch {
        /* */
      }
    }
    overlay.addEventListener("pointerdown", down)
    overlay.addEventListener("pointermove", move)
    overlay.addEventListener("pointerup", up)
    overlay.addEventListener("pointercancel", up)

    this.hostListeners.push(() => {
      overlay.removeEventListener("pointerdown", down)
      overlay.removeEventListener("pointermove", move)
      overlay.removeEventListener("pointerup", up)
      overlay.removeEventListener("pointercancel", up)
      overlay.remove()
    })
  }

  private disableInputs(): void {
    for (const c of this.hostListeners) c()
    this.hostListeners = []
    this.current = null
  }

  private beginStroke(p: { x: number; y: number }): void {
    if (!this.container) return
    const g = new PIXI.Graphics()
    const stroke: Stroke = {
      graphics: g,
      tool: this.tool,
      points: [p],
      style: { ...this.style },
    }
    this.current = stroke
    this.strokes.push(stroke)
    this.undone = []
    this.container.addChild(g)
    this.redraw(stroke)
  }

  private extendStroke(p: { x: number; y: number }): void {
    if (!this.current) return
    this.current.points.push(p)
    this.redraw(this.current)
  }

  private endStroke(p: { x: number; y: number }): void {
    if (!this.current) return
    this.current.points.push(p)
    this.redraw(this.current)
    this.current = null
  }

  private redraw(stroke: Stroke): void {
    const g = stroke.graphics
    g.clear()
    const pts = stroke.points
    if (pts.length === 0) return
    switch (stroke.tool) {
      case "pen":
      case "highlight":
        g.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length; i++) {
          g.lineTo(pts[i].x, pts[i].y)
        }
        g.stroke({
          color: stroke.style.color,
          width: stroke.tool === "highlight" ? stroke.style.width * 4 : stroke.style.width,
          alpha: stroke.tool === "highlight" ? 0.35 : stroke.style.alpha,
          cap: "round",
          join: "round",
        })
        break
      case "rectangle": {
        const a = pts[0]
        const b = pts[pts.length - 1]
        g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
        g.stroke({ color: stroke.style.color, width: stroke.style.width, alpha: stroke.style.alpha })
        break
      }
      case "arrow": {
        const a = pts[0]
        const b = pts[pts.length - 1]
        g.moveTo(a.x, a.y).lineTo(b.x, b.y)
        // Arrowhead.
        const dx = b.x - a.x
        const dy = b.y - a.y
        const ang = Math.atan2(dy, dx)
        const head = 14
        g.moveTo(b.x, b.y)
        g.lineTo(b.x - head * Math.cos(ang - Math.PI / 6), b.y - head * Math.sin(ang - Math.PI / 6))
        g.moveTo(b.x, b.y)
        g.lineTo(b.x - head * Math.cos(ang + Math.PI / 6), b.y - head * Math.sin(ang + Math.PI / 6))
        g.stroke({
          color: stroke.style.color,
          width: stroke.style.width,
          alpha: stroke.style.alpha,
          cap: "round",
          join: "round",
        })
        break
      }
    }
  }
}
