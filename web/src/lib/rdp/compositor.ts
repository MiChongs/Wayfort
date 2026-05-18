// PixiCompositor — overlay-only renderer (Plan 16).
//
// Originally Plan 15 made Pixi the primary visible surface by blitting
// Guacamole's default-layer canvas each frame. That regressed the cursor:
// Guac's cursor lives on a SEPARATE child canvas we never mirrored, and
// the wrapper holding it was hidden at opacity:0. Plan 16 flips the
// architecture — Guacamole renders all desktop layers (background +
// cursor + buffers) as-is, and Pixi sits ON TOP as a transparent overlay
// for annotations / future GPU effects.
//
// Consequences:
//   • Cursor, intermediate buffers, layered RDP elements all "just work".
//   • Zoom uses Guacamole.Display.scale() (library-native, propagates to
//     every layer including the cursor's CSS position).
//   • Screenshot / recording compose the desktop frame by walking Guac's
//     child canvases (see lib/rdp/compose.ts).
//   • Pixi stage contains annotation strokes (and any future overlay-only
//     effects). attachSourceCanvas / setRemoteSize / applyHostTransform
//     are removed — they served the old "Pixi is primary" model.

import * as PIXI from "pixi.js"

export type CompositorFilter = "none" | "privacy" | "grayscale"

export interface CompositorOptions {
  // Container we mount our Pixi canvas into. Must have non-zero dimensions
  // by the time init() is called (we resize-to it).
  host: HTMLElement
  // Initial background colour behind the remote desktop sprite. Black so
  // letterboxing isn't jarring.
  backgroundColor?: number
}

export class PixiCompositor {
  private app: PIXI.Application | null = null
  private filterStage: PIXI.Filter[] = []
  private destroyed = false
  // Stage where overlay plugins (annotation, minimap container) add their
  // display objects. After Plan 16 there's no desktop sprite below them —
  // the stage is transparent and sits over Guacamole's own canvases.
  stage: PIXI.Container | null = null

  async init(opts: CompositorOptions): Promise<void> {
    if (this.destroyed) throw new Error("compositor destroyed before init")
    this.app = new PIXI.Application()
    await this.app.init({
      resizeTo: opts.host,
      // Plan 16: transparent overlay. The visible desktop comes from
      // Guacamole's element underneath; we just paint annotations on top.
      backgroundAlpha: 0,
      preference: "webgl",
      antialias: false,
      autoDensity: true,
      resolution: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    })
    if (this.destroyed) {
      this.app.destroy(true)
      this.app = null
      return
    }
    this.app.canvas.style.position = "absolute"
    this.app.canvas.style.inset = "0"
    this.app.canvas.style.width = "100%"
    this.app.canvas.style.height = "100%"
    // Pointer-events:none lets mouse / touch fall through to the Guac
    // canvas beneath us so its input handlers fire normally. Annotation
    // mode toggles an HTMLDivElement overlay above (see annotation
    // plugin) when it needs to intercept events for drawing.
    this.app.canvas.style.pointerEvents = "none"
    // z-index above Guac canvases (which Guac places without explicit
    // z-index) but below the floating toolbar / loader (z-20+).
    this.app.canvas.style.zIndex = "5"
    opts.host.appendChild(this.app.canvas)
    this.stage = this.app.stage
  }

  // Plan 16: filter API kept for the annotation stage so users can still
  // privacy-blur their own overlays. Filtering the remote desktop directly
  // is left to Plan 17's full-mirror renderer.
  setFilter(name: CompositorFilter): void {
    if (!this.stage) return
    this.disposeFilters()
    switch (name) {
      case "privacy":
        this.filterStage = [new PIXI.BlurFilter({ strength: 12 })]
        break
      case "grayscale":
        this.filterStage = [this.makeGrayscaleFilter()]
        break
      default:
        this.filterStage = []
    }
    this.stage.filters = this.filterStage
  }

  // Async screenshot of the current rendered frame including all overlays.
  // We render the stage to a render texture then extract canvas → blob.
  async snapshot(): Promise<HTMLCanvasElement> {
    if (!this.app) throw new Error("compositor not initialised")
    const canvas = await this.app.renderer.extract.canvas(this.app.stage)
    return canvas as HTMLCanvasElement
  }

  // The actual HTMLCanvasElement Pixi renders to — used by recording's
  // captureStream() and by screenshots that need an immediate handle.
  getRenderCanvas(): HTMLCanvasElement {
    if (!this.app) throw new Error("compositor not initialised")
    return this.app.canvas
  }

  getApp(): PIXI.Application {
    if (!this.app) throw new Error("compositor not initialised")
    return this.app
  }

  destroy(): void {
    this.destroyed = true
    if (this.app) {
      this.disposeFilters()
      this.app.destroy(true, { children: true, texture: true })
      this.app = null
    }
    this.stage = null
  }

  private disposeFilters(): void {
    for (const f of this.filterStage) {
      try {
        f.destroy()
      } catch {
        /* */
      }
    }
    this.filterStage = []
  }

  private makeGrayscaleFilter(): PIXI.Filter {
    const f = new PIXI.ColorMatrixFilter()
    f.desaturate()
    return f
  }
}
