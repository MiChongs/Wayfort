/// <reference lib="webworker" />
import { decode as decodePng } from "fast-png"
import { decompressSync } from "fflate"
import { decode as decodeJpeg } from "jpeg-js"
import { probeH264Avc420, supportsImageDecoder, supportsVideoDecoder } from "./capabilities"
import type { Encoding, FrameRect } from "./types"

type FrameRectMeta = Omit<FrameRect, "payload">

interface DecodeFrameInput {
  frame: FrameRectMeta
  payload: Uint8Array
}

interface DecodedFrameOutput {
  frame: FrameRectMeta
  bitmap?: ImageBitmap
  imageData?: ImageData
}

type WorkerIn =
  | { type: "decode"; id: number; frames: DecodeFrameInput[] }
  | { type: "close" }

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

ctx.addEventListener("message", async (event: MessageEvent<WorkerIn>) => {
  const msg = event.data
  if (msg.type === "close") {
    closeVideoDecoder()
    return
  }
  if (msg.type !== "decode") return

  try {
    const frames = await Promise.all(msg.frames.map(decodeFrame))
    const transfer: Transferable[] = []
    for (const frame of frames) {
      if (frame.bitmap) transfer.push(frame.bitmap)
      if (frame.imageData) transfer.push(frame.imageData.data.buffer)
    }
    ctx.postMessage({ type: "decoded", id: msg.id, frames }, transfer)
  } catch (error) {
    ctx.postMessage({ type: "error", id: msg.id, message: String(error) })
  }
})

let warnedRFX = false

async function decodeFrame(input: DecodeFrameInput): Promise<DecodedFrameOutput> {
  const { frame, payload } = input
  validateFrame(frame)
  if (frame.encoding === "raw_bgra" || frame.encoding === "zlib_bgra") {
    const bgra = frame.encoding === "zlib_bgra" ? inflateBgraPayload(payload, frame.width, frame.height) : payload
    return { frame, imageData: rawBgraToImageData(bgra, frame.width, frame.height) }
  }
  if (frame.encoding === "jpeg" || frame.encoding === "png") {
    return await decodeJpegOrPng(frame, payload)
  }
  if (frame.encoding === "h264") {
    return await decodeH264Frame(frame, payload)
  }
  if (frame.encoding === "rfx") {
    if (!warnedRFX) {
      ctx.postMessage({ type: "warn", message: "rfx frames received but RemoteFX decoder is not wired; operator should disable enable_remote_fx in node options" })
      warnedRFX = true
    }
    throw new Error("rfx decode path not implemented; disable enable_remote_fx in node proto_options")
  }
  throw new Error(`unsupported frame encoding: ${frame.encoding}`)
}

// ───────────────────────────────────────────────────────────────────────────
// H.264 / WebCodecs VideoDecoder lifecycle
// ───────────────────────────────────────────────────────────────────────────
//
// A single VideoDecoder lives per worker (= per RDP session) because
// the decoder is stateful: SPS/PPS parsed from the first IDR slice
// configure the codec, and every subsequent delta refers to the
// reference frames the decoder remembers internally. Closing the
// session (or a decoder error) tears it down.
//
// Decoded output arrives via the `output` callback async — there's no
// promise to await directly. We assign each EncodedVideoChunk a
// monotonic `timestamp` (which the decoder echoes back on the matching
// VideoFrame), look up the pending resolver in `pendingH264` and
// resolve it. A timestamp Map is fine for the rates RDP runs at
// (typically <60 fps); for higher-throughput use cases a ring buffer
// could replace it.
//
// On error, the spec says the VideoDecoder ends up in `closed` state
// and can't be reused — we close it and clear pending so the next
// frame (which will be the next keyframe the server sends after the
// browser-side `Refresh Rect` PDU lands) starts a fresh decoder.

interface PendingH264 {
  resolve(out: DecodedFrameOutput): void
  reject(err: Error): void
  frame: FrameRectMeta
}

let videoDecoder: VideoDecoder | null = null
let videoDecoderProbed: boolean | null = null
let videoDecoderConfigured = false
let h264TimestampSeq = 0
const pendingH264 = new Map<number, PendingH264>()

async function ensureVideoDecoder(): Promise<VideoDecoder | null> {
  if (videoDecoder && videoDecoderConfigured) return videoDecoder
  if (!supportsVideoDecoder()) return null
  if (videoDecoderProbed === null) {
    videoDecoderProbed = await probeH264Avc420()
  }
  if (!videoDecoderProbed) return null
  if (videoDecoder) {
    try { videoDecoder.close() } catch { /* already closed */ }
    videoDecoder = null
  }
  const decoder = new VideoDecoder({
    output(videoFrame) {
      void deliverH264Frame(videoFrame)
    },
    error(err) {
      const message = err instanceof Error ? err.message : String(err)
      for (const pending of pendingH264.values()) {
        pending.reject(new Error(`VideoDecoder error: ${message}`))
      }
      pendingH264.clear()
      ctx.postMessage({ type: "warn", message: `VideoDecoder errored, will reconfigure on next keyframe: ${message}` })
      // Ask the gateway to push a refresh PDU so the server emits a new
      // IDR right away; without that, the next keyframe arrives only
      // when the server feels like it and the user stares at a frozen
      // screen for seconds. Main thread (canvas-renderer.onRefreshNeeded)
      // forwards this to the worker over WS as ClientMessage.refresh.
      ctx.postMessage({ type: "refresh-needed" })
      hasSeenH264Keyframe = false
      try { videoDecoder?.close() } catch { /* */ }
      videoDecoder = null
      videoDecoderConfigured = false
    },
  })
  decoder.configure({
    codec: "avc1.42E01E", // H.264 Constrained Baseline level 3.0 — matches RDPGFX AVC420
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true,
  })
  videoDecoder = decoder
  videoDecoderConfigured = true
  return decoder
}

async function deliverH264Frame(videoFrame: VideoFrame): Promise<void> {
  const pending = pendingH264.get(videoFrame.timestamp)
  if (!pending) {
    // Output arrived without a corresponding decode() request — drop
    // the frame to avoid leaking GPU buffers.
    videoFrame.close()
    return
  }
  pendingH264.delete(videoFrame.timestamp)
  try {
    const bitmap = await createImageBitmap(videoFrame)
    pending.resolve({ frame: pending.frame, bitmap })
  } catch (e) {
    pending.reject(e instanceof Error ? e : new Error(String(e)))
  } finally {
    videoFrame.close()
  }
}

async function decodeH264Frame(
  frame: FrameRectMeta,
  payload: Uint8Array,
): Promise<DecodedFrameOutput> {
  const decoder = await ensureVideoDecoder()
  if (!decoder) {
    throw new Error("VideoDecoder unavailable: browser lacks WebCodecs.VideoDecoder support for H.264 AVC420")
  }
  // A delta arriving before the decoder has its first keyframe will
  // make the decoder error out (per spec). Reject early with a clear
  // message so the worker can request a refresh on the WS instead of
  // pushing junk that makes the next keyframe also unrenderable.
  if (decoder.decodeQueueSize === 0 && !frame.keyframe && pendingH264.size === 0 && !hasSeenH264Keyframe) {
    throw new Error("H.264 delta frame arrived before keyframe; waiting for next IDR")
  }
  if (frame.keyframe) hasSeenH264Keyframe = true

  return new Promise<DecodedFrameOutput>((resolve, reject) => {
    const ts = ++h264TimestampSeq
    pendingH264.set(ts, { resolve, reject, frame })
    try {
      decoder.decode(new EncodedVideoChunk({
        type: frame.keyframe ? "key" : "delta",
        timestamp: ts,
        data: payload,
      }))
    } catch (e) {
      pendingH264.delete(ts)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

let hasSeenH264Keyframe = false

function closeVideoDecoder() {
  hasSeenH264Keyframe = false
  for (const pending of pendingH264.values()) {
    pending.reject(new Error("worker closing"))
  }
  pendingH264.clear()
  if (videoDecoder) {
    try { videoDecoder.close() } catch { /* */ }
    videoDecoder = null
  }
  videoDecoderConfigured = false
  videoDecoderProbed = null
}

// JPEG / PNG decode picks the fastest available path. ImageDecoder is
// the modern API (Chromium 94+, Safari 17+) and lets us skip the Blob
// allocation; `createImageBitmap` is the established native path that
// works in every Chromium / Safari / Firefox we ship to. Both
// produce ImageBitmap or VideoFrame that's transferable to the main
// thread without copy. The js-only library decode (jpeg-js /
// fast-png) is reserved for the case where neither native path
// works at runtime — kept around so an old browser still renders,
// just slowly.
async function decodeJpegOrPng(
  frame: FrameRectMeta,
  payload: Uint8Array,
): Promise<DecodedFrameOutput> {
  const encoding = frame.encoding as "jpeg" | "png"
  const mime = encoding === "jpeg" ? "image/jpeg" : "image/png"

  if (supportsImageDecoder()) {
    try {
      const decoder = new ImageDecoder({ data: payload, type: mime })
      const result = await decoder.decode()
      const bitmap = await createImageBitmap(result.image)
      result.image.close()
      decoder.close()
      return { frame, bitmap }
    } catch {
      // ImageDecoder is configured but threw — fall through to the
      // older path. Browsers occasionally ship the API in a
      // half-working state (Safari 17.0) and the right answer is to
      // try the next native option instead of giving up.
    }
  }

  const blob = new Blob([payload as BlobPart], { type: mime })
  try {
    return { frame, bitmap: await createImageBitmap(blob) }
  } catch {
    // Final resort: JS decode. Reached only on stripped-down
    // execution environments without ImageDecoder or
    // createImageBitmap support — keeps display alive at a high CPU
    // cost.
    return { frame, imageData: decodeEncodedImage(payload, encoding) }
  }
}

function validateFrame(frame: FrameRectMeta) {
  if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)) throw new Error("invalid frame origin")
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height)) throw new Error("invalid frame size")
  if (frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0) throw new Error("invalid frame bounds")
}

function inflateBgraPayload(bytes: Uint8Array, width: number, height: number) {
  const out = decompressSync(bytes)
  const expected = width * height * 4
  if (out.length < expected) {
    throw new Error(`zlib BGRA payload too small after inflate: got ${out.length}, need ${expected}`)
  }
  return out
}

function rawBgraToImageData(bytes: Uint8Array, width: number, height: number): ImageData {
  const expected = width * height * 4
  if (bytes.length < expected) {
    throw new Error(`raw BGRA payload too small: got ${bytes.length}, need ${expected}`)
  }
  const image = new ImageData(width, height)
  const dst = image.data
  for (let src = 0, i = 0; i < expected; src += 4, i += 4) {
    dst[i] = bytes[src + 2]
    dst[i + 1] = bytes[src + 1]
    dst[i + 2] = bytes[src]
    dst[i + 3] = 255
  }
  return image
}

function decodeEncodedImage(bytes: Uint8Array, encoding: Extract<Encoding, "jpeg" | "png">): ImageData {
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
