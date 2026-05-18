// PixiCompositor — Plan 15's core renderer.
//
// Guacamole's Display draws into its own internal HTMLCanvasElement via
// 2D context. We grab that canvas, upload it as a PIXI.Texture each frame
// (zero-copy on modern browsers — Texture.source.update() just rebinds the
// canvas as the WebGL texture data source), and let Pixi composite it with
// any overlay sprites we add (cursor, annotations, minimap).
//
// Why this beats Guacamole's vanilla rendering:
//   - GPU-accelerated compositing: zoom/pan transforms run on the GPU,
//     anti-aliased correctly instead of blurry CSS bilinear interpolation.
//   - One canvas in the DOM (the Pixi one) — easier to overlay sprites,
//     apply filters (privacy blur, contrast), capture screenshots.
//   - Stage-level snapshot includes annotation overlays for free.
//
// Why we don't rewrite Guacamole.Display entirely: see Plan 15 Context. The
// protocol layer keeps doing its 30+ drawing primitives correctly; we just
// take over the *display* surface.

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
  private sprite: PIXI.Sprite | null = null
  private texture: PIXI.Texture | null = null
  private filterStage: PIXI.Filter[] = []
  private destroyed = false
  // Re-exposed so plugins can add display objects above the remote sprite.
  stage: PIXI.Container | null = null

  async init(opts: CompositorOptions): Promise<void> {
    if (this.destroyed) throw new Error("compositor destroyed before init")
    this.app = new PIXI.Application()
    await this.app.init({
      resizeTo: opts.host,
      backgroundColor: opts.backgroundColor ?? 0x000000,
      // Pixi auto-detects WebGL2 → WebGL1 → canvas2d in that order.
      // We prefer webgl over webgpu for now: WebGPU is still rolling out
      // and we want consistent behaviour across browsers.
      preference: "webgl",
      // Pixel-art clarity for terminals and code editors > smoothing.
      antialias: false,
      autoDensity: true,
      // High DPI screens — let Pixi handle the devicePixelRatio scaling.
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
    // Critical: events must pass through to Guac's hidden element underneath
    // (see input-bridge.ts). Pointer-events:none on the Pixi canvas does it.
    this.app.canvas.style.pointerEvents = "none"
    opts.host.appendChild(this.app.canvas)
    this.stage = this.app.stage
  }

  // Wire up the source canvas (Guacamole's internal drawing surface). Once
  // attached, we re-upload it to the GPU each Pixi tick.
  attachSourceCanvas(canvas: HTMLCanvasElement): void {
    if (!this.app || !this.stage) {
      throw new Error("compositor not initialised")
    }
    // Tear down any previous attachment so re-attach after reconnect works.
    if (this.sprite) {
      this.sprite.destroy()
      this.sprite = null
    }
    if (this.texture) {
      this.texture.destroy(true)
      this.texture = null
    }
    this.texture = PIXI.Texture.from(canvas)
    this.sprite = new PIXI.Sprite(this.texture)
    // Always at z=0 — plugins add above.
    this.stage.addChildAt(this.sprite, 0)
    // Ticker fires at 60Hz (or display rate). Each tick we tell the texture
    // its backing canvas may have changed. Update is cheap on WebGL — just
    // dirties the texture binding; the actual GPU upload only happens on
    // the next draw call. ~0.5ms per frame on modern hardware.
    this.app.ticker.add(this.tick)
  }

  // Resize the visible sprite to match the remote desktop dimensions. Called
  // from Guacamole's Display.onresize. The stage transform handles zoom/pan
  // for the user — this is just "intrinsic size".
  setRemoteSize(width: number, height: number): void {
    if (!this.sprite) return
    this.sprite.width = width
    this.sprite.height = height
  }

  // Apply a GPU filter chain. "privacy" blurs the desktop heavily (useful
  // when sharing the browser tab); "grayscale" desaturates.
  setFilter(name: CompositorFilter): void {
    if (!this.sprite) return
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
    this.sprite.filters = this.filterStage
  }

  // Apply a CSS transform to the host (zoom + pan). Pixi handles its own
  // canvas the same way the input bridge handles Guac's — we use a single
  // transform on a parent wrapper so the two stay aligned.
  applyHostTransform(scale: number, x: number, y: number): void {
    if (!this.app || !this.stage) return
    // Drive Pixi stage transform directly — keeps WebGL pipeline consistent
    // (avoids browser CSS scale that defeats the GPU advantage).
    this.stage.scale.set(scale)
    this.stage.position.set(x, y)
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
      this.app.ticker.remove(this.tick)
      this.disposeFilters()
      this.app.destroy(true, { children: true, texture: true })
      this.app = null
    }
    this.sprite = null
    this.texture = null
    this.stage = null
  }

  private tick = (): void => {
    if (this.texture) this.texture.source.update()
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
