// composeFrame — Plan 16.B helper. Builds a single composite canvas that
// represents the user-visible remote desktop (all Guac canvases stacked in
// their library-assigned order, including the cursor layer) plus any Pixi
// overlay (annotation strokes). Used by screenshot + recording, both of
// which previously relied on a single Pixi-owned canvas before Plan 16
// flipped the architecture.
//
// Performance: walks displayEl.children, reads CSS top/left/transform for
// each child canvas via getBoundingClientRect against the display element
// itself (so library-set transforms are honoured), then drawImage into a
// 2D context. For a typical RDP session this is 2-4 child canvases at
// 1080p — measured ~1ms per call on modern hardware.

export interface ComposeInput {
  // The HTMLElement returned by Guacamole.Client.getDisplay().getElement().
  displayEl: HTMLElement
  // Optional transparent overlay (Pixi canvas) drawn on top after all Guac
  // canvases. May be null when no annotations exist.
  overlayCanvas?: HTMLCanvasElement | null
  // Remote desktop logical dimensions (Guacamole.Display tells us via
  // onresize). composeFrame uses these to size the output unless `target`
  // is supplied with a non-zero size.
  remoteW: number
  remoteH: number
  // Optional reusable target — avoids reallocating a canvas every frame
  // when recording. Caller must size it; we'll resize if needed.
  target?: HTMLCanvasElement
}

export function composeFrame(input: ComposeInput): HTMLCanvasElement {
  const { displayEl, overlayCanvas, remoteW, remoteH } = input
  const w = remoteW > 0 ? remoteW : 1280
  const h = remoteH > 0 ? remoteH : 720
  const out = input.target ?? document.createElement("canvas")
  if (out.width !== w) out.width = w
  if (out.height !== h) out.height = h
  const ctx = out.getContext("2d", { willReadFrequently: false })
  if (!ctx) return out
  ctx.clearRect(0, 0, w, h)

  // Walk every <canvas> descendant of the display element in DOM order
  // (Guacamole layers are siblings, but be defensive against any wrapper
  // divs the library may introduce in future versions).
  const canvases = displayEl.querySelectorAll<HTMLCanvasElement>("canvas")
  const baseRect = displayEl.getBoundingClientRect()
  for (const c of canvases) {
    if (c.width === 0 || c.height === 0) continue
    // Per-canvas position relative to the display element. We can't read
    // CSS left/top directly (might be in % or computed via transform), so
    // use getBoundingClientRect and subtract the parent rect, then divide
    // by any user-driven Guac scale baked into the parent (we account for
    // that by passing remoteW/H which is in REMOTE pixels — Guac canvases
    // have width attr in remote pixels too, regardless of CSS transform).
    //
    // Practically: each Guac child canvas has `width="<remoteWidth>"` for
    // background, `width="<cursorWidth>"` for cursor, and CSS transform
    // pinning to (0,0) for background or (cursorX, cursorY) for cursor.
    // Using rect math relative to the parent works because both are
    // measured in the same CSS-transformed space — the ratio cancels out.
    const r = c.getBoundingClientRect()
    const scaleX = baseRect.width === 0 ? 1 : w / baseRect.width
    const scaleY = baseRect.height === 0 ? 1 : h / baseRect.height
    const dx = (r.left - baseRect.left) * scaleX
    const dy = (r.top - baseRect.top) * scaleY
    const dw = r.width * scaleX
    const dh = r.height * scaleY
    try {
      ctx.drawImage(c, dx, dy, dw, dh)
    } catch {
      /* tainted canvas — skip */
    }
  }

  if (overlayCanvas && overlayCanvas.width > 0 && overlayCanvas.height > 0) {
    try {
      // Overlay is sized to the Pixi viewport (== host CSS px). Stretch to
      // the remote space — annotations are stored in remote coords by the
      // AnnotationPlugin, but the Pixi canvas itself paints them in
      // viewport space. For screenshots this is "good enough"; future
      // refinement could grab the Pixi stage at remote resolution via
      // app.renderer.extract.canvas(stage, { resolution: remoteW/hostW }).
      ctx.drawImage(overlayCanvas, 0, 0, w, h)
    } catch {
      /* */
    }
  }
  return out
}
