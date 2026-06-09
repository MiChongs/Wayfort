// Main-thread canvas renderer for the legacy FreeRDP/dummy desktop path.
//
// The previous implementation transferred the canvas to an OffscreenCanvas
// worker. That made the lifecycle hard to reason about in React dev mode and
// hid decoder failures behind worker messages. This renderer keeps ownership
// in the component tree and exposes explicit frame-paint methods used by
// FrameClient's wire decoder.
import { base64ToBytes, type CursorUpdate, type Encoding, type FrameRect } from "./types"
import { createWebGPUSurface, type DesktopSurface } from "./webgpu-surface"

export type FrameRectMeta = Omit<FrameRect, "payload">

export interface FrameBytes {
  frame: FrameRectMeta
  payload: Uint8Array
}

// Mirror of decode.worker.ts DecoderPath. Kept local because workers
// are bundled with separate type roots and a re-export would force
// the worker module into the main thread's dependency graph.
export type DecoderPath = "videodecoder" | "imagedecoder" | "imagebitmap" | "js"

interface DecodedFrame {
  frame: FrameRectMeta
  bitmap?: ImageBitmap
  imageData?: ImageData
  // Raw un-swapped BGRA pixels — only present on the WebGPU surface path (the
  // worker is told gpu=true and returns these instead of an ImageBitmap).
  bgra?: Uint8Array
  decoderPath?: DecoderPath
}

type DecodeWorkerMessage =
  | { type: "decoded"; id: number; frames: DecodedFrame[] }
  | { type: "error"; id: number; message: string }
  // Out-of-band signals — not tied to a decode request id.
  | { type: "warn"; message: string }
  | { type: "refresh-needed" }

interface DecodeRequest {
  resolve(frames: DecodedFrame[]): void
  reject(error: Error): void
}

const MAX_CANVAS_EDGE = 8192
const MAX_CANVAS_PIXELS = 8192 * 8192
const MAX_PENDING_PAINT_FRAMES = 128
// Hard cap on the bytes held in the pending-paint queue. A busy desktop on the
// bitmap fallback can flood raw_bgra rects (~8 MB each at 1080p) faster than the
// canvas can paint; without a byte cap the queue grows to MAX_PENDING_PAINT_FRAMES
// × frame-size (≈1 GB) and the tab OOMs. 96 MB absorbs a healthy burst while
// keeping the ceiling far below where a browser tab dies.
const MAX_PENDING_PAINT_BYTES = 96 * 1024 * 1024
const METRICS_INTERVAL_MS = 1000

// RenderMetrics is the 1 Hz snapshot the renderer emits for the perf
// panel. `framesPainted` resets every window so it converts directly
// to FPS; `droppedFrames` is monotonic so the panel can chart the
// cumulative drop curve and derive a per-second rate by diffing.
//
// `codec` and `decoderPath` are the most-used values across the
// window — when traffic mixes encodings the dominant one wins. Both
// are `null` until at least one frame paints in the window so the
// UI can show "—" instead of a stale value at session start.
export interface RenderMetrics {
  avgDecodeMs: number
  avgPaintMs: number
  framesPainted: number
  droppedFrames: number
  codec: Encoding | null
  decoderPath: DecoderPath | null
  // Which compositing surface the session resolved to: "webgpu" (raw-BGRA
  // GPU-texture fast path) or "canvas2d" (fallback). null until the async
  // surface selection completes. Lets the perf panel confirm the GPU path is
  // actually live in the operator's browser.
  renderSurface: "webgpu" | "canvas2d" | null
}

export interface CanvasRendererHandle {
  canvas: HTMLCanvasElement
  resize(width: number, height: number): void
  paintFrame(frame: FrameRect): void
  paintFrameBytes(frame: FrameRectMeta, payload: Uint8Array): void
  paintFrameBatchBytes(frames: FrameBytes[]): void
  // Called when the renderer grows to match remote desktop bounds.
  onResize(cb: (w: number, h: number) => void): () => void
  // Kept for API symmetry with older callers. Cursor decoding is now emitted
  // directly by FrameClient, but a renderer can still fan out cursor updates.
  onCursor(cb: (cursor: CursorUpdate) => void): () => void
  emitCursor(cursor: CursorUpdate): void
  onError(cb: (message: string) => void): () => void
  // 1 Hz performance snapshot used by the desktop perf panel.
  onMetrics(cb: (m: RenderMetrics) => void): () => void
  // Fired when the decode worker hits a VideoDecoder error and needs
  // the server to send a new IDR frame. Consumer should forward this
  // to the WS layer as a `refresh` ClientMessage.
  onRefreshNeeded(cb: () => void): () => void
  destroy(): void
}

export function createRenderer(initialW: number, initialH: number): CanvasRendererHandle {
  const canvas = document.createElement("canvas")
  canvas.width = initialW
  canvas.height = initialH
  canvas.style.maxWidth = "100%"
  canvas.style.maxHeight = "100%"
  canvas.style.imageRendering = "auto"
  canvas.style.touchAction = "none"

  // Rendering surface. Chosen once, asynchronously: WebGPU when available (skips
  // the per-pixel BGRA→RGBA swap and the createImageBitmap copy by uploading raw
  // BGRA into a bgra8unorm texture), otherwise the proven Canvas 2D path. Frames
  // that arrive before the surface resolves wait in pendingFrames and flush once
  // `surfaceReady` flips. A canvas can hold only one context kind, so this never
  // switches mid-session.
  let surface: DesktopSurface | null = null
  let surfaceReady = false

  const resizeCbs: Array<(w: number, h: number) => void> = []
  const cursorCbs: Array<(cursor: CursorUpdate) => void> = []
  const errorCbs: Array<(message: string) => void> = []
  const metricsCbs: Array<(m: RenderMetrics) => void> = []
  const refreshCbs: Array<() => void> = []

  let pendingFrames: FrameBytes[] = []
  let pendingBytes = 0
  let painting = false
  let paintRaf = 0
  let destroyed = false
  let decodeSeq = 0
  const decodeRequests = new Map<number, DecodeRequest>()
  // Decode worker pool. A batch's stateless rects (raw/zlib/zstd BGRA, JPEG, PNG)
  // are split across workers to use multiple cores; H.264 batches stay whole on
  // worker 0 because the VideoDecoder is stateful (deltas reference frames only
  // it remembers). Capped at 4 like the worker-side encode pool.
  const poolSize = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))
  const decodeWorkers = createDecodeWorkers(
    poolSize,
    (message) => emitError(message),
    decodeRequests,
    () => {
      if (destroyed) return
      for (const cb of refreshCbs) cb()
    },
  )

  // Kick off async surface selection. createWebGPUSurface validates WebGPU on a
  // throwaway canvas before claiming this one, so a failure leaves the canvas
  // pristine for the Canvas 2D fallback (zero regression). Until it resolves,
  // schedulePaintFlush short-circuits on !surfaceReady and frames queue.
  void (async () => {
    let chosen: DesktopSurface | null = null
    try {
      chosen = await createWebGPUSurface(canvas, canvas.width, canvas.height, (m) =>
        emitError(`desktop webgpu: ${m}`),
      )
    } catch (error) {
      emitError(`desktop webgpu init threw, using canvas2d: ${String(error)}`)
      chosen = null
    }
    if (!chosen) chosen = createCanvas2DSurface(canvas, emitError)
    if (destroyed) {
      chosen.destroy()
      return
    }
    surface = chosen
    surfaceReady = true
    // Drain anything that queued while we were probing the GPU.
    schedulePaintFlush()
  })()

  // Perf-panel accumulators. Times are summed across the 1 s window and
  // divided by `framesPainted` on emit. `droppedFrames` is the total
  // count of pending frames thrown away because a near-full-canvas
  // update arrived (see `paintFrameBatchBytes`) or because the queue
  // exceeded MAX_PENDING_PAINT_FRAMES. Stays monotonic across windows.
  let decodeAccumMs = 0
  let paintAccumMs = 0
  let framesPaintedWindow = 0
  let droppedFramesTotal = 0
  // Vote counters for the 1 s window. Most-common wins on emit.
  // Map<value, count> for codec + decoderPath keep the math trivial
  // and avoid a separate sample buffer.
  const codecCounts = new Map<Encoding, number>()
  const decoderPathCounts = new Map<DecoderPath, number>()
  // Sticky last-known values — used when the window has zero frames
  // (idle desktop) so the panel keeps showing the last codec the
  // session was on instead of flickering to "—".
  let lastCodec: Encoding | null = null
  let lastDecoderPath: DecoderPath | null = null
  const metricsTimer = window.setInterval(() => {
    if (destroyed) return
    if (framesPaintedWindow === 0 && droppedFramesTotal === 0) return
    const dominantCodec = mostCommon(codecCounts) ?? lastCodec
    const dominantPath = mostCommon(decoderPathCounts) ?? lastDecoderPath
    if (dominantCodec) lastCodec = dominantCodec
    if (dominantPath) lastDecoderPath = dominantPath
    const snapshot: RenderMetrics = {
      avgDecodeMs: framesPaintedWindow > 0 ? decodeAccumMs / framesPaintedWindow : 0,
      avgPaintMs: framesPaintedWindow > 0 ? paintAccumMs / framesPaintedWindow : 0,
      framesPainted: framesPaintedWindow,
      droppedFrames: droppedFramesTotal,
      codec: dominantCodec,
      decoderPath: dominantPath,
      renderSurface: surface?.kind ?? null,
    }
    for (const cb of metricsCbs) cb(snapshot)
    decodeAccumMs = 0
    paintAccumMs = 0
    framesPaintedWindow = 0
    codecCounts.clear()
    decoderPathCounts.clear()
  }, METRICS_INTERVAL_MS)

  function emitResize(width: number, height: number) {
    if (destroyed) return
    for (const cb of resizeCbs) cb(width, height)
  }

  function emitError(message: string) {
    if (destroyed) return
    for (const cb of errorCbs) cb(message)
  }

  function resize(width: number, height: number) {
    if (destroyed) return
    const nextW = Math.max(1, Math.floor(width))
    const nextH = Math.max(1, Math.floor(height))
    if (!isSafeCanvasSize(nextW, nextH)) {
      emitError(`remote desktop size too large: ${nextW}x${nextH}`)
      return
    }
    if (canvas.width === nextW && canvas.height === nextH) return
    canvas.width = nextW
    canvas.height = nextH
    // The WebGPU surface accumulates into an offscreen framebuffer that must be
    // resized to match (it preserves the overlap so unchanged regions survive).
    // Canvas 2D's surface.resize is a no-op — its backing store follows the
    // canvas element directly.
    surface?.resize(nextW, nextH)
    emitResize(nextW, nextH)
  }

  function ensureRectFits(frame: FrameRectMeta) {
    const neededW = Math.max(canvas.width, frame.x + frame.width)
    const neededH = Math.max(canvas.height, frame.y + frame.height)
    if (neededW !== canvas.width || neededH !== canvas.height) {
      resize(neededW, neededH)
    }
  }

  function paintFrame(frame: FrameRect) {
    if (destroyed) return
    paintFrameBytes(frame, base64ToBytes(frame.payload))
  }

  function paintFrameBytes(frame: FrameRectMeta, payload: Uint8Array) {
    paintFrameBatchBytes([{ frame, payload }])
  }

  function paintFrameBatchBytes(frames: FrameBytes[]) {
    if (destroyed) return
    if (frames.length === 0) return
    if (frames.some((item) => isNearFullCanvasFrame(canvas, item.frame))) {
      // Full-canvas update obsoletes everything queued — count the lot
      // as dropped so the perf panel can chart the burst.
      droppedFramesTotal += pendingFrames.length
      pendingFrames = []
      pendingBytes = 0
    }
    for (const item of frames) {
      pendingFrames.push(item)
      pendingBytes += item.payload.byteLength
    }
    trimPendingPaintFrames()
    schedulePaintFlush()
  }

  // Keep the pending queue within both the frame-count and byte budgets so a
  // raw_bgra flood can't grow it without bound (the OOM path). Preference order:
  // (1) collapse to the newest full-canvas frame if one is queued — it
  // obsoletes everything before it for free; (2) otherwise drop the oldest
  // partial rects (last-writer-wins makes stale partials safe-ish, and the
  // server's periodic repaints heal any gap — not OOMing matters more).
  function trimPendingPaintFrames() {
    if (pendingFrames.length <= MAX_PENDING_PAINT_FRAMES && pendingBytes <= MAX_PENDING_PAINT_BYTES) {
      return
    }
    for (let i = pendingFrames.length - 1; i >= 0; i--) {
      if (isNearFullCanvasFrame(canvas, pendingFrames[i].frame)) {
        droppedFramesTotal += i
        pendingFrames = pendingFrames.slice(i)
        pendingBytes = sumPayloadBytes(pendingFrames)
        break
      }
    }
    while (
      pendingFrames.length > 1 &&
      (pendingFrames.length > MAX_PENDING_PAINT_FRAMES || pendingBytes > MAX_PENDING_PAINT_BYTES)
    ) {
      const dropped = pendingFrames.shift()
      if (!dropped) break
      pendingBytes -= dropped.payload.byteLength
      droppedFramesTotal += 1
    }
  }

  function schedulePaintFlush() {
    if (paintRaf !== 0 || painting || destroyed || !surfaceReady) return
    paintRaf = requestAnimationFrame(() => {
      paintRaf = 0
      void runPaintFlush()
    })
  }

  // One decode+paint in flight at a time. The previous design chained every
  // rAF onto a promise (`paintQueue = paintQueue.then(...)`); when decode ran
  // slower than the rAF cadence the chain — and the frame batches it captured —
  // grew without bound. A single in-flight guard + reschedule keeps exactly one
  // batch's worth of decoded bitmaps live at once.
  async function runPaintFlush() {
    if (destroyed || painting) return
    const surf = surface
    if (!surf) return // surface still resolving; schedulePaintFlush will retry
    const batch = pendingFrames
    pendingFrames = []
    pendingBytes = 0
    if (batch.length === 0) return
    painting = true
    try {
      // Time-box the decode (worker round-trip) and paint (drawImage /
      // putImageData) phases separately so the perf panel can split
      // "GPU upload" cost from "decode" cost.
      const decodeStart = performance.now()
      const decoded = await decodeBatch(batch)
      const paintStart = performance.now()
      if (destroyed) {
        // Torn down mid-decode — release the GPU bitmaps we'll never paint.
        for (const item of decoded) item?.bitmap?.close()
        return
      }
      for (const item of decoded) if (item) ensureRectFits(item.frame)
      for (const item of decoded) {
        if (!item) continue
        // The surface consumes whichever representation the decode produced:
        // raw bgra (WebGPU fast path), an ImageBitmap, or ImageData. It owns the
        // bitmap lifecycle from here (closes it after upload).
        surf.paint({
          x: item.frame.x,
          y: item.frame.y,
          width: item.frame.width,
          height: item.frame.height,
          bgra: item.bgra,
          bitmap: item.bitmap,
          imageData: item.imageData,
        })
      }
      // Present the whole batch once (WebGPU: a single copyTextureToTexture from
      // the accumulated framebuffer to the swapchain; Canvas 2D: a no-op).
      surf.present()
      const paintEnd = performance.now()
      const decodedCount = decoded.filter(Boolean).length
      if (decodedCount > 0) {
        decodeAccumMs += paintStart - decodeStart
        paintAccumMs += paintEnd - paintStart
        framesPaintedWindow += decodedCount
        for (const item of decoded) {
          if (!item) continue
          const enc = item.frame.encoding
          codecCounts.set(enc, (codecCounts.get(enc) ?? 0) + 1)
          if (item.decoderPath) {
            decoderPathCounts.set(
              item.decoderPath,
              (decoderPathCounts.get(item.decoderPath) ?? 0) + 1,
            )
          }
        }
      }
    } catch (error) {
      if (!destroyed) emitError(`frame paint failed: ${String(error)}`)
    } finally {
      painting = false
      // Frames that arrived while painting wait in pendingFrames — drain them.
      if (!destroyed && pendingFrames.length > 0) schedulePaintFlush()
    }
  }

  function decodeBatch(batch: FrameBytes[]): Promise<DecodedFrame[]> {
    if (decodeWorkers.length === 0) {
      return Promise.reject(new Error("desktop decode worker unavailable"))
    }
    // On the WebGPU surface, ask the worker for raw BGRA bytes (no swap, no
    // ImageBitmap) for raw/zlib/zstd BGRA frames; Canvas 2D wants the swapped
    // ImageBitmap as before.
    const gpu = surface?.wantsRawBGRA === true
    const hasH264 = batch.some((f) => f.frame.encoding === "h264")
    // Whole batch on worker 0 when there's nothing to parallelise, or an H.264
    // frame pins the batch to the stateful decoder there.
    if (decodeWorkers.length === 1 || batch.length <= 1 || hasH264) {
      return decodeOn(0, batch, gpu)
    }
    // Split the stateless batch into contiguous chunks (one per worker): order is
    // preserved within each chunk and across chunks (concatenated in order), so
    // overlapping dirty rects still composite last-writer-wins correctly.
    const n = Math.min(decodeWorkers.length, batch.length)
    const chunkSize = Math.ceil(batch.length / n)
    const chunks: FrameBytes[][] = []
    for (let i = 0; i < batch.length; i += chunkSize) chunks.push(batch.slice(i, i + chunkSize))
    return Promise.all(chunks.map((c, i) => decodeOn(i, c, gpu))).then((parts) => parts.flat())
  }

  function decodeOn(workerIdx: number, batch: FrameBytes[], gpu: boolean): Promise<DecodedFrame[]> {
    const worker = decodeWorkers[workerIdx] ?? decodeWorkers[0]
    const id = ++decodeSeq
    const transfer = uniquePayloadTransferList(batch)
    return new Promise<DecodedFrame[]>((resolve, reject) => {
      decodeRequests.set(id, { resolve, reject })
      try {
        worker.postMessage({ type: "decode", id, frames: batch, gpu }, transfer)
      } catch (error) {
        decodeRequests.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    canvas,
    resize,
    paintFrame,
    paintFrameBytes,
    paintFrameBatchBytes,
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
    emitCursor: (cursor) => {
      if (destroyed) return
      for (const cb of cursorCbs) cb(cursor)
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
    onRefreshNeeded: (cb) => {
      refreshCbs.push(cb)
      return () => {
        const i = refreshCbs.indexOf(cb)
        if (i >= 0) refreshCbs.splice(i, 1)
      }
    },
    destroy: () => {
      destroyed = true
      window.clearInterval(metricsTimer)
      if (paintRaf !== 0) {
        cancelAnimationFrame(paintRaf)
        paintRaf = 0
      }
      surface?.destroy()
      surface = null
      surfaceReady = false
      pendingFrames = []
      pendingBytes = 0
      for (const request of decodeRequests.values()) {
        request.reject(new Error("renderer destroyed"))
      }
      decodeRequests.clear()
      for (const worker of decodeWorkers) {
        try {
          worker.postMessage({ type: "close" })
        } catch {
          /* ignore */
        }
        worker.terminate()
      }
      resizeCbs.length = 0
      cursorCbs.length = 0
      errorCbs.length = 0
      metricsCbs.length = 0
      refreshCbs.length = 0
      canvas.remove()
    },
  }
}

// `paintDecodedBatch` used to be a standalone helper; it's now inlined in
// `schedulePaintFlush` so decode/paint timing closes over the metrics
// accumulators without an extra closure-capture parameter set.

// mostCommon picks the highest-count key from a Map (which is also
// insertion-order, so ties go to the encoding/path seen first this
// window). Returns null on an empty map so callers can decide to keep
// a sticky previous value.
function mostCommon<K>(counts: Map<K, number>): K | null {
  let bestKey: K | null = null
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count
      bestKey = key
    }
  }
  return bestKey
}

function sumPayloadBytes(frames: FrameBytes[]): number {
  let total = 0
  for (const item of frames) total += item.payload.byteLength
  return total
}

function isSafeFrame(frame: FrameRectMeta) {
  if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)) return false
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height)) return false
  if (frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0) return false
  const right = frame.x + frame.width
  const bottom = frame.y + frame.height
  if (!isSafeCanvasSize(right, bottom)) return false
  return frame.width * frame.height <= MAX_CANVAS_PIXELS
}

function isSafeCanvasSize(width: number, height: number) {
  return width > 0 && height > 0 && width <= MAX_CANVAS_EDGE && height <= MAX_CANVAS_EDGE && width * height <= MAX_CANVAS_PIXELS
}

function isNearFullCanvasFrame(canvas: HTMLCanvasElement, frame: FrameRectMeta) {
  if (frame.x !== 0 || frame.y !== 0) return false
  if (canvas.width <= 0 || canvas.height <= 0) return false
  return frame.width * 100 >= canvas.width * 95 && frame.height * 100 >= canvas.height * 95
}

// createCanvas2DSurface wraps the original Canvas 2D paint path behind the
// DesktopSurface interface so the renderer can treat it interchangeably with the
// WebGPU surface. Behaviour is byte-for-byte the pre-WebGPU path: drawImage for
// bitmaps (closing them after), putImageData for the JS-fallback ImageData. It
// never receives `bgra` because wantsRawBGRA is false, so the decode worker keeps
// returning swapped ImageBitmaps for this surface.
function createCanvas2DSurface(
  canvas: HTMLCanvasElement,
  emitError: (message: string) => void,
): DesktopSurface {
  const ctx = canvas.getContext("2d", { alpha: false })
  if (!ctx) emitError("Canvas 2D context unavailable")
  return {
    kind: "canvas2d",
    wantsRawBGRA: false,
    resize() {
      /* 2D backing store follows the canvas element; nothing to do here. */
    },
    paint(item) {
      if (!ctx) return
      if (item.bitmap) {
        ctx.drawImage(item.bitmap, item.x, item.y, item.width, item.height)
        item.bitmap.close()
      } else if (item.imageData) {
        ctx.putImageData(item.imageData, item.x, item.y)
      }
    },
    present() {
      /* immediate-mode canvas — each drawImage already shows; nothing to flush. */
    },
    destroy() {
      /* the 2D context is released when the canvas element is removed. */
    },
  }
}

function createDecodeWorkers(
  count: number,
  emitError: (message: string) => void,
  requests: Map<number, DecodeRequest>,
  emitRefreshNeeded: () => void,
): Worker[] {
  const workers: Worker[] = []
  for (let i = 0; i < count; i++) {
    const w = createDecodeWorker(emitError, requests, emitRefreshNeeded)
    if (w) workers.push(w)
  }
  return workers
}

function createDecodeWorker(
  emitError: (message: string) => void,
  requests: Map<number, DecodeRequest>,
  emitRefreshNeeded: () => void,
) {
  try {
    const worker = new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module" })
    worker.addEventListener("message", (event: MessageEvent<DecodeWorkerMessage>) => {
      const msg = event.data
      if (msg.type === "refresh-needed") {
        emitRefreshNeeded()
        return
      }
      if (msg.type === "warn") {
        // Surface worker-side warnings (e.g. h264 frames arriving on an
        // unsupported browser) via the same channel as errors so
        // consumers can route them to logs / toast.
        emitError(`desktop decode worker warning: ${msg.message}`)
        return
      }
      const request = requests.get(msg.id)
      if (!request) return
      requests.delete(msg.id)
      if (msg.type === "decoded") {
        request.resolve(msg.frames)
      } else {
        request.reject(new Error(msg.message))
      }
    })
    worker.addEventListener("error", (event) => {
      emitError(`desktop decode worker error: ${event.message}`)
    })
    return worker
  } catch (error) {
    emitError(`desktop decode worker unavailable: ${String(error)}`)
    return null
  }
}

function uniquePayloadTransferList(frames: FrameBytes[]): Transferable[] {
  const seen = new Set<ArrayBuffer>()
  const transfer: Transferable[] = []
  for (const item of frames) {
    const buffer = item.payload.buffer
    if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
      seen.add(buffer)
      transfer.push(buffer)
    }
  }
  return transfer
}
