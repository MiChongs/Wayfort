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
import { base64ToBytes, type FrameRect, type ServerMessage } from "./types"

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

let canvas: OffscreenCanvas | null = null
let g2d: OffscreenCanvasRenderingContext2D | null = null
let canvasW = 0
let canvasH = 0

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
        await paintFrame(data.msg.frame)
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
        /* malformed frame — skip */
      }
      return
    }
  }
}
