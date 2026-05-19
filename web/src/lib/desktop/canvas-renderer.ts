// Main-thread canvas renderer for the legacy FreeRDP/dummy desktop path.
//
// The previous implementation transferred the canvas to an OffscreenCanvas
// worker. That made the lifecycle hard to reason about in React dev mode and
// hid decoder failures behind worker messages. This renderer keeps ownership
// in the component tree and exposes explicit frame-paint methods used by
// FrameClient's wire decoder.
import { base64ToBytes, type CursorUpdate, type Encoding, type FrameRect } from "./types"

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

  const g2d = canvas.getContext("2d", { alpha: false })

  const resizeCbs: Array<(w: number, h: number) => void> = []
  const cursorCbs: Array<(cursor: CursorUpdate) => void> = []
  const errorCbs: Array<(message: string) => void> = []
  const metricsCbs: Array<(m: RenderMetrics) => void> = []
  const refreshCbs: Array<() => void> = []

  let paintQueue = Promise.resolve()
  let pendingFrames: FrameBytes[] = []
  let paintRaf = 0
  let destroyed = false
  let decodeSeq = 0
  const decodeRequests = new Map<number, DecodeRequest>()
  const decodeWorker = createDecodeWorker(
    (message) => emitError(message),
    decodeRequests,
    () => {
      if (destroyed) return
      for (const cb of refreshCbs) cb()
    },
  )

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
    if (!g2d) {
      emitError("Canvas 2D context unavailable")
      return
    }
    if (frames.length === 0) return
    if (frames.some((item) => isNearFullCanvasFrame(canvas, item.frame))) {
      // Full-canvas update obsoletes everything queued — count the lot
      // as dropped so the perf panel can chart the burst.
      droppedFramesTotal += pendingFrames.length
      pendingFrames = []
    }
    pendingFrames.push(...frames)
    trimPendingPaintFrames()
    schedulePaintFlush()
  }

  function trimPendingPaintFrames() {
    if (pendingFrames.length <= MAX_PENDING_PAINT_FRAMES) return
    for (let i = pendingFrames.length - 1; i >= 0; i--) {
      if (isNearFullCanvasFrame(canvas, pendingFrames[i].frame)) {
        // Drop everything before the most recent full-canvas frame.
        droppedFramesTotal += i
        pendingFrames = pendingFrames.slice(i)
        return
      }
    }
  }

  function schedulePaintFlush() {
    if (paintRaf !== 0 || destroyed) return
    paintRaf = requestAnimationFrame(() => {
      paintRaf = 0
      const batch = pendingFrames
      pendingFrames = []
      if (batch.length === 0 || destroyed) return
      const ctx = g2d
      if (!ctx) {
        emitError("Canvas 2D context unavailable")
        return
      }
      // Time-box the decode (worker round-trip) and paint (drawImage /
      // putImageData) phases separately so the perf panel can split
      // "GPU upload" cost from "decode" cost — the latter is what
      // hurts on JPEG-heavy sessions, the former on huge raw frames.
      paintQueue = paintQueue
        .then(async () => {
          const decodeStart = performance.now()
          const decoded = await decodeBatch(batch)
          const paintStart = performance.now()
          for (const item of decoded) if (item) ensureRectFits(item.frame)
          for (const item of decoded) {
            if (!item) continue
            if (item.bitmap) {
              ctx.drawImage(item.bitmap, item.frame.x, item.frame.y, item.frame.width, item.frame.height)
              item.bitmap.close()
            } else if (item.imageData) {
              ctx.putImageData(item.imageData, item.frame.x, item.frame.y)
            }
          }
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
        })
        .catch((error) => {
          if (!destroyed) emitError(`frame paint failed: ${String(error)}`)
        })
    })
  }

  function decodeBatch(batch: FrameBytes[]) {
    if (!decodeWorker) {
      return Promise.reject(new Error("desktop decode worker unavailable"))
    }
    const id = ++decodeSeq
    const transfer = uniquePayloadTransferList(batch)
    return new Promise<DecodedFrame[]>((resolve, reject) => {
      decodeRequests.set(id, { resolve, reject })
      try {
        decodeWorker.postMessage({ type: "decode", id, frames: batch }, transfer)
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
      pendingFrames = []
      for (const request of decodeRequests.values()) {
        request.reject(new Error("renderer destroyed"))
      }
      decodeRequests.clear()
      if (decodeWorker) {
        try {
          decodeWorker.postMessage({ type: "close" })
        } catch {
          /* ignore */
        }
        decodeWorker.terminate()
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
