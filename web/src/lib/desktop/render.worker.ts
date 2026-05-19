// Plan 17 render worker. Owns an OffscreenCanvas transferred from the
// main thread and handles BGRA / JPEG / PNG frame decoding off the UI
// thread. Receives:
//
//   { type: "init",   canvas: OffscreenCanvas, width: 1280, height: 720 }
//   { type: "server", msg: ServerMessage }       — FrameRect or CursorUpdate
//   { type: "resize", width: number, height: number }
//   { type: "close" }
//
// Posts back to main thread:
//
//   { type: "cursor", x: number, y: number, png: string }   — for DOM cursor
//   { type: "ready" }
//
// Decoding the test pattern (raw BGRA) is putImageData after swapping
// channel order; for JPEG/PNG we createImageBitmap + drawImage. The
// canvas is sized to the remote desktop pixel dimensions; CSS scales it
// to fit the host.

/// <reference lib="webworker" />
import { decode as decodePng } from "fast-png"
import { decode as decodeJpeg } from "jpeg-js"
import { base64ToBytes, type FrameRect, type ServerMessage } from "./types"

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

let canvas: OffscreenCanvas | null = null
let g2d: OffscreenCanvasRenderingContext2D | null = null
let canvasW = 0
let canvasH = 0

// Block B — performance instrumentation. Sums and counters reset every
// time we emit, so the main thread receives moving averages over the
// last `METRICS_INTERVAL_MS` window. `droppedFrames` is monotonic
// because the perf panel charts cumulative drops over time.
const METRICS_INTERVAL_MS = 1000
let decodeAccumMs = 0
let paintAccumMs = 0
let framesPainted = 0
let droppedFrames = 0
let metricsLastEmit = 0

function maybeEmitMetrics(now: number) {
  if (now - metricsLastEmit < METRICS_INTERVAL_MS) return
  // Only emit if we actually did work — keeps the panel quiet for
  // idle sessions instead of spamming zero rows.
  if (framesPainted === 0 && droppedFrames === 0) {
    metricsLastEmit = now
    return
  }
  ctx.postMessage({
    type: "metrics",
    avgDecodeMs: framesPainted > 0 ? decodeAccumMs / framesPainted : 0,
    avgPaintMs: framesPainted > 0 ? paintAccumMs / framesPainted : 0,
    framesPainted,
    droppedFrames,
  })
  decodeAccumMs = 0
  paintAccumMs = 0
  framesPainted = 0
  metricsLastEmit = now
}

// Stale-frame coalescer. The server can deliver bursts (multiple frame
// rects from one batch) faster than the GPU can present them. Without
// coalescing, slow paths queue up and the worker spends most of its
// time decoding frames the user will never see. We keep one queued
// frame per region key (currently a single global slot since the
// dummy backend sends full-canvas frames); newer arrivals replace
// older ones and bump the dropped counter.
let pendingFrame: FrameRect | null = null
let coalesceRaf = 0
function schedulePaint() {
  if (coalesceRaf !== 0) return
  // requestAnimationFrame inside a worker is supported in modern
  // browsers (Chrome 79+, Edge 79+, Safari 16.4+, Firefox 100+).
  // Falling back to setTimeout(0) is fine where rAF is missing — it
  // just loses the visibility-pause behaviour.
  const raf =
    typeof self.requestAnimationFrame === "function"
      ? self.requestAnimationFrame
      : (cb: FrameRequestCallback) =>
          self.setTimeout(() => cb(performance.now()), 0) as unknown as number
  coalesceRaf = raf((ts) => {
    coalesceRaf = 0
    const next = pendingFrame
    pendingFrame = null
    if (!next) return
    void paintFrame(next)
    maybeEmitMetrics(ts)
  })
}

ctx.addEventListener("message", async (ev: MessageEvent) => {
  const data = ev.data as
    | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
    | { type: "server"; msg: ServerMessage }
    | { type: "resize"; width: number; height: number }
    | { type: "close" }
  switch (data.type) {
    case "init": {
      canvas = data.canvas
      canvasW = data.width
      canvasH = data.height
      const c = canvas.getContext("2d")
      if (!c) {
        ctx.postMessage({ type: "error", message: "OffscreenCanvas 2D context unavailable" })
        return
      }
      g2d = c
      ctx.postMessage({ type: "ready" })
      return
    }
    case "resize": {
      if (!canvas) return
      canvasW = data.width
      canvasH = data.height
      canvas.width = canvasW
      canvas.height = canvasH
      return
    }
    case "server": {
      if (data.msg.frame) {
        // Coalesce — if a previous frame is still pending, this one
        // displaces it. The displaced frame was never painted so it
        // counts as dropped. schedulePaint() drives the paint via the
        // worker's rAF so we naturally pace with the display refresh.
        if (pendingFrame) droppedFrames++
        pendingFrame = data.msg.frame
        schedulePaint()
      } else if (data.msg.cursor) {
        // Forward to main thread which sets the DOM cursor (PNG-data URL
        // applied to the <canvas>'s `cursor` style). Worker can't do that
        // — DOM access requires main thread.
        ctx.postMessage({
          type: "cursor",
          x: data.msg.cursor.hotspot_x,
          y: data.msg.cursor.hotspot_y,
          png: data.msg.cursor.png,
        })
      }
      return
    }
    case "close": {
      // Free decoder caches if any. Currently nothing persistent.
      return
    }
  }
})

async function paintFrame(f: FrameRect): Promise<void> {
  if (!g2d || !canvas) return
  // Auto-grow canvas to match remote dimensions (worker dummy may resize).
  const neededW = Math.max(canvasW, f.x + f.width)
  const neededH = Math.max(canvasH, f.y + f.height)
  if (canvas.width !== neededW || canvas.height !== neededH) {
    canvas.width = neededW
    canvas.height = neededH
    canvasW = neededW
    canvasH = neededH
    // Notify main thread so it can reflow the wrapper.
    ctx.postMessage({ type: "resized", width: neededW, height: neededH })
  }
  // Two timers: `decodeStart`→`paintStart` measures bytes→ImageBitmap
  // (or ImageData) decoding cost; `paintStart`→end measures the actual
  // draw call onto the GPU-backed OffscreenCanvas. Recorded into the
  // accumulators picked up by `maybeEmitMetrics`.
  const decodeStart = performance.now()
  const bytes = base64ToBytes(f.payload)
  switch (f.encoding) {
    case "raw_bgra": {
      const id = g2d.createImageData(f.width, f.height)
      // BGRA → RGBA in place. We could pre-allocate this buffer in M1.5;
      // for a 640×360 test pattern it's only 900KB / frame so the GC
      // pressure is tolerable.
      const dst = id.data
      for (let i = 0; i < bytes.length; i += 4) {
        dst[i] = bytes[i + 2]
        dst[i + 1] = bytes[i + 1]
        dst[i + 2] = bytes[i]
        dst[i + 3] = bytes[i + 3]
      }
      const paintStart = performance.now()
      g2d.putImageData(id, f.x, f.y)
      const end = performance.now()
      decodeAccumMs += paintStart - decodeStart
      paintAccumMs += end - paintStart
      framesPainted++
      return
    }
    case "jpeg":
    case "png": {
      const blob = new Blob([bytes as BlobPart], {
        type: f.encoding === "jpeg" ? "image/jpeg" : "image/png",
      })
      try {
        const bmp = await createImageBitmap(blob)
        const paintStart = performance.now()
        g2d.drawImage(bmp, f.x, f.y, f.width, f.height)
        const end = performance.now()
        bmp.close()
        decodeAccumMs += paintStart - decodeStart
        paintAccumMs += end - paintStart
        framesPainted++
      } catch {
        try {
          const image = decodeFrameBytes(bytes, f.encoding)
          const paintStart = performance.now()
          g2d.putImageData(image, f.x, f.y)
          const end = performance.now()
          decodeAccumMs += paintStart - decodeStart
          paintAccumMs += end - paintStart
          framesPainted++
        } catch (error) {
          ctx.postMessage({
            type: "error",
            message: `frame decode failed: ${String(error)}`,
          })
        }
      }
      return
    }
  }
}

function decodeFrameBytes(bytes: Uint8Array, encoding: "jpeg" | "png"): ImageData {
  if (encoding === "jpeg") {
    const jpeg = decodeJpeg(bytes, {
      colorTransform: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: 256,
      maxResolutionInMP: 64,
      tolerantDecoding: true,
      useTArray: true,
    })
    return new ImageData(new Uint8ClampedArray(jpeg.data), jpeg.width, jpeg.height)
  }

  const png = decodePng(bytes)
  return new ImageData(
    normalizePngData(png.data, png.width, png.height, png.channels, png.depth),
    png.width,
    png.height,
  )
}

function normalizePngData(
  data: Uint8Array | Uint8ClampedArray | Uint16Array,
  width: number,
  height: number,
  channels: number,
  depth: number,
) {
  const pixels = width * height
  const rgba = new Uint8ClampedArray(pixels * 4)
  const max = depth >= 16 ? 65535 : (1 << depth) - 1

  for (let i = 0; i < pixels; i++) {
    const src = i * channels
    const dst = i * 4

    if (channels === 1) {
      const gray = scaleSample(data[src], max)
      rgba[dst] = gray
      rgba[dst + 1] = gray
      rgba[dst + 2] = gray
      rgba[dst + 3] = 255
    } else if (channels === 2) {
      const gray = scaleSample(data[src], max)
      rgba[dst] = gray
      rgba[dst + 1] = gray
      rgba[dst + 2] = gray
      rgba[dst + 3] = scaleSample(data[src + 1], max)
    } else {
      rgba[dst] = scaleSample(data[src], max)
      rgba[dst + 1] = scaleSample(data[src + 1], max)
      rgba[dst + 2] = scaleSample(data[src + 2], max)
      rgba[dst + 3] = channels >= 4 ? scaleSample(data[src + 3], max) : 255
    }
  }

  return rgba
}

function scaleSample(value: number, max: number) {
  if (max === 255) return value
  return Math.round((value / max) * 255)
}
