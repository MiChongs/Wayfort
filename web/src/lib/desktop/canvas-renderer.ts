// Plan 17 main-thread renderer bootstrap. Creates a <canvas>, transfers
// control to a DedicatedWorker, and exposes a tiny API the React
// component uses to mount it + react to worker events (resize / cursor).
//
// The worker URL is resolved via the `new URL(..., import.meta.url)`
// pattern Next.js / Turbopack natively supports — no extra config.

// RenderMetrics is the 1Hz snapshot the worker emits for the perf panel.
// `framesPainted` resets every window, so dividing by elapsed gives FPS;
// `droppedFrames` is monotonic so we can chart cumulative drop count.
export interface RenderMetrics {
  avgDecodeMs: number
  avgPaintMs: number
  framesPainted: number
  droppedFrames: number
}

export interface CanvasRendererHandle {
  canvas: HTMLCanvasElement
  worker: Worker
  // Called when the worker reports the remote desktop has resized.
  onResize(cb: (w: number, h: number) => void): () => void
  // Called when the worker forwards a cursor update; consumer applies
  // the PNG as `style.cursor: url(...) hotX hotY, auto`.
  onCursor(cb: (data: { x: number; y: number; png: string }) => void): () => void
  onError(cb: (message: string) => void): () => void
  // 1 Hz performance snapshot from the OffscreenCanvas worker. Wired
  // into the SessionStats pipeline by the LegacyDesktopDisplay so the
  // perf panel can chart decode / paint cost and dropped frames.
  onMetrics(cb: (m: RenderMetrics) => void): () => void
  destroy(): void
}

export function createRenderer(initialW: number, initialH: number): CanvasRendererHandle {
  const canvas = document.createElement("canvas")
  canvas.width = initialW
  canvas.height = initialH
  canvas.style.maxWidth = "100%"
  canvas.style.maxHeight = "100%"
  canvas.style.imageRendering = "pixelated"
  canvas.style.touchAction = "none"

  const offscreen = canvas.transferControlToOffscreen()
  const worker = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" })
  worker.postMessage(
    { type: "init", canvas: offscreen, width: initialW, height: initialH },
    [offscreen],
  )

  const resizeCbs: Array<(w: number, h: number) => void> = []
  const cursorCbs: Array<(d: { x: number; y: number; png: string }) => void> = []
  const errorCbs: Array<(message: string) => void> = []
  const metricsCbs: Array<(m: RenderMetrics) => void> = []
  worker.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as
      | { type: "ready" }
      | { type: "resized"; width: number; height: number }
      | { type: "cursor"; x: number; y: number; png: string }
      | { type: "error"; message: string }
      | ({ type: "metrics" } & RenderMetrics)
    if (data.type === "resized") {
      for (const cb of resizeCbs) cb(data.width, data.height)
    } else if (data.type === "cursor") {
      for (const cb of cursorCbs) cb(data)
    } else if (data.type === "error") {
      for (const cb of errorCbs) cb(data.message)
    } else if (data.type === "metrics") {
      const snapshot: RenderMetrics = {
        avgDecodeMs: data.avgDecodeMs,
        avgPaintMs: data.avgPaintMs,
        framesPainted: data.framesPainted,
        droppedFrames: data.droppedFrames,
      }
      for (const cb of metricsCbs) cb(snapshot)
    }
  })

  return {
    canvas,
    worker,
    onResize: (cb) => {
      resizeCbs.push(cb)
      return () => {
        const i = resizeCbs.indexOf(cb)
        if (i >= 0) resizeCbs.splice(i, 1)
      }
    },
    onCursor: (cb) => {
      cursorCbs.push(cb)
      return () => {
        const i = cursorCbs.indexOf(cb)
        if (i >= 0) cursorCbs.splice(i, 1)
      }
    },
    onError: (cb) => {
      errorCbs.push(cb)
      return () => {
        const i = errorCbs.indexOf(cb)
        if (i >= 0) errorCbs.splice(i, 1)
      }
    },
    onMetrics: (cb) => {
      metricsCbs.push(cb)
      return () => {
        const i = metricsCbs.indexOf(cb)
        if (i >= 0) metricsCbs.splice(i, 1)
      }
    },
    destroy: () => {
      try {
        worker.postMessage({ type: "close" })
      } catch {
        /* */
      }
      worker.terminate()
    },
  }
}
