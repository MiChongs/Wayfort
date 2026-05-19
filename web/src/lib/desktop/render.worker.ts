// Plan 17 render worker. Owns an OffscreenCanvas transferred from the
// main thread and handles BGRA / JPEG / PNG frame decoding off the UI
// thread. Receives:
//
//   { type: "init",   canvas: OffscreenCanvas, width: 1280, height: 720 }
//   { type: "server", msg: ServerMessage }       — FrameRect or CursorUpdate
//   { type: "frame-bytes", frame, payload }      — desktop.v2 binary frame
//   { type: "resize", width: number, height: number }
//   { type: "close" }
//
// Posts back to main thread:
//
//   { type: "cursor", cursor: CursorUpdate }   — for DOM cursor
//   { type: "ready" }
//
// Decoding the test pattern (raw BGRA) is putImageData after swapping
// channel order; for JPEG/PNG we createImageBitmap + drawImage. The
// canvas is sized to the remote desktop pixel dimensions; CSS scales it
// to fit the host.

/// <reference lib="webworker" />
import { decode as decodePng } from "fast-png"
import { decompressSync } from "fflate"
import { decode as decodeJpeg } from "jpeg-js"
import { base64ToBytes, type FrameRect, type ServerMessage } from "./types"

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

let canvas: OffscreenCanvas | null = null
let g2d: OffscreenCanvasRenderingContext2D | null = null
let canvasW = 0
let canvasH = 0

type FrameRectMeta = Omit<FrameRect, "payload">

ctx.addEventListener("message", async (ev: MessageEvent) => {
  const data = ev.data as
    | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
    | { type: "server"; msg: ServerMessage }
    | { type: "frame-bytes"; frame: FrameRectMeta; payload: Uint8Array }
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
        await paintFrame(data.msg.frame)
      } else if (data.msg.cursor) {
        // Forward to main thread which sets the DOM cursor. Worker can't do
        // that — DOM access requires main thread.
        ctx.postMessage({
          type: "cursor",
          cursor: data.msg.cursor,
        })
      }
      return
    }
    case "frame-bytes": {
      await paintFrameBytes(data.frame, data.payload)
      return
    }
    case "close": {
      // Free decoder caches if any. Currently nothing persistent.
      return
    }
  }
})

async function paintFrame(f: FrameRect): Promise<void> {
  await paintFrameBytes(f, base64ToBytes(f.payload))
}

async function paintFrameBytes(f: FrameRectMeta, bytes: Uint8Array): Promise<void> {
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
  switch (f.encoding) {
    case "raw_bgra":
    case "zlib_bgra": {
      let bgra: Uint8Array
      try {
        bgra = f.encoding === "zlib_bgra" ? inflateBgraPayload(bytes, f.width, f.height) : bytes
      } catch (error) {
        ctx.postMessage({
          type: "error",
          message: `frame decode failed: ${String(error)}`,
        })
        return
      }
      const expected = f.width * f.height * 4
      if (bgra.length < expected) {
        ctx.postMessage({
          type: "error",
          message: `${f.encoding} payload too small: got ${bgra.length}, need ${expected}`,
        })
        return
      }
      const id = g2d.createImageData(f.width, f.height)
      // BGRA → RGBA in place. We could pre-allocate this buffer in M1.5;
      // for a 640×360 test pattern it's only 900KB / frame so the GC
      // pressure is tolerable.
      const dst = id.data
      for (let i = 0; i < expected; i += 4) {
        dst[i] = bgra[i + 2]
        dst[i + 1] = bgra[i + 1]
        dst[i + 2] = bgra[i]
        // FreeRDP desktop pixels are BGRX; treating X as alpha causes black or
        // transparent artifacts on some servers.
        dst[i + 3] = 255
      }
      g2d.putImageData(id, f.x, f.y)
      return
    }
    case "jpeg":
    case "png": {
      const blob = new Blob([bytes as BlobPart], {
        type: f.encoding === "jpeg" ? "image/jpeg" : "image/png",
      })
      try {
        const bmp = await createImageBitmap(blob)
        g2d.drawImage(bmp, f.x, f.y, f.width, f.height)
        bmp.close()
      } catch {
        try {
          const image = decodeFrameBytes(bytes, f.encoding)
          g2d.putImageData(image, f.x, f.y)
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

function inflateBgraPayload(bytes: Uint8Array, width: number, height: number) {
  const out = decompressSync(bytes)
  const expected = width * height * 4
  if (out.length < expected) {
    throw new Error(`zlib BGRA payload too small after inflate: got ${out.length}, need ${expected}`)
  }
  return out
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
