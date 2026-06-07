/// <reference lib="webworker" />
import { unzlibSync } from "fflate"
import { probeH264Avc420, supportsImageDecoder, supportsVideoDecoder } from "./capabilities"
import type { Encoding, FrameRect } from "./types"

// The pure-JS image codecs (jpeg-js / fast-png) are the ultimate fallback, only
// reached when BOTH ImageDecoder and createImageBitmap are unavailable. They're
// heavy (hundreds of KB, big per-decode allocations), so they're dynamically
// imported on first use instead of sitting in the worker's baseline memory.

type FrameRectMeta = Omit<FrameRect, "payload">

interface DecodeFrameInput {
  frame: FrameRectMeta
  payload: Uint8Array
}

// DecoderPath names the actual code path taken for the most recent
// decode. The perf panel surfaces this so operators can verify the
// session is on the GPU path (videodecoder), the modern native image
// path (imagedecoder), the legacy native path (imagebitmap), or the
// pure-JS path that's only reached when nothing else works.
export type DecoderPath = "videodecoder" | "imagedecoder" | "imagebitmap" | "js"

interface DecodedFrameOutput {
  frame: FrameRectMeta
  bitmap?: ImageBitmap
  imageData?: ImageData
  // bgra carries raw, un-swapped BGRA pixels (width*height*4) for the WebGPU
  // surface fast path: it uploads them straight into a bgra8unorm texture, so we
  // skip both the per-pixel BGRA→RGBA swap and the createImageBitmap copy the
  // Canvas 2D path needs. Only produced when the decode request set gpu=true.
  bgra?: Uint8Array
  decoderPath?: DecoderPath
}

type WorkerIn =
  // gpu=true means the renderer is on the WebGPU surface and wants raw BGRA bytes
  // back for raw_bgra/zlib_bgra frames instead of a pre-swapped ImageBitmap.
  | { type: "decode"; id: number; frames: DecodeFrameInput[]; gpu?: boolean }
  | { type: "close" }

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

ctx.addEventListener("message", async (event: MessageEvent<WorkerIn>) => {
  const msg = event.data
  if (msg.type === "close") {
    closeVideoDecoder()
    return
  }
  if (msg.type !== "decode") return

  // Decode sequentially with a per-frame guard. The gateway coalesces up to
  // 32 mixed-encoding frames into one batch (ws_handler.coalesceFrameMessages),
  // so a single throwing frame — an RFX frame with no decoder, an H.264 delta
  // that arrived before its keyframe, or a truncated BGRA payload — must NOT
  // discard the whole batch (which would also drop a keyframe coalesced
  // alongside it and stall the H.264 stream). Sequential ordering also makes
  // the keyframe set `hasSeenH264Keyframe` before any following delta in the
  // same batch is checked, so a keyframe+delta batch decodes correctly.
  const gpu = msg.gpu === true
  const frames: DecodedFrameOutput[] = []
  for (const input of msg.frames) {
    try {
      frames.push(await decodeFrame(input, gpu))
    } catch (error) {
      // Skip just this frame; report out-of-band so the rest still paint.
      ctx.postMessage({ type: "warn", message: `frame decode skipped: ${String(error)}` })
    }
  }
  const transfer: Transferable[] = []
  for (const frame of frames) {
    if (frame.bitmap) transfer.push(frame.bitmap)
    if (frame.imageData) transfer.push(frame.imageData.data.buffer)
    if (frame.bgra) transfer.push(frame.bgra.buffer)
  }
  ctx.postMessage({ type: "decoded", id: msg.id, frames }, transfer)
})

let warnedRFX = false

async function decodeFrame(input: DecodeFrameInput, gpu: boolean): Promise<DecodedFrameOutput> {
  const { frame, payload } = input
  validateFrame(frame)
  if (frame.encoding === "raw_bgra" || frame.encoding === "zlib_bgra") {
    return await decodeBgraFrame(frame, payload, gpu)
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
    // The decoded VideoFrame's coded size is padded to 16-px macroblock
    // multiples (e.g. a 1920×1080 surface decodes to 1920×1088). The renderer
    // draws this into the surface-command rect (frame.width×frame.height) with
    // drawImage, which would stretch the padded picture into the smaller rect
    // and squash/garble it. Crop to the rect's top-left region so the bitmap
    // is exactly frame.width×frame.height and paints 1:1.
    const cw = videoFrame.codedWidth || pending.frame.width
    const ch = videoFrame.codedHeight || pending.frame.height
    const w = Math.max(1, Math.min(pending.frame.width, cw))
    const h = Math.max(1, Math.min(pending.frame.height, ch))
    const bitmap = await createImageBitmap(videoFrame, 0, 0, w, h)
    pending.resolve({ frame: pending.frame, bitmap, decoderPath: "videodecoder" })
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
      return { frame, bitmap, decoderPath: "imagedecoder" }
    } catch {
      // ImageDecoder is configured but threw — try the next native
      // option instead of giving up. Browsers occasionally ship the
      // API in a half-working state (Safari 17.0).
    }
  }

  const blob = new Blob([payload as BlobPart], { type: mime })
  try {
    return { frame, bitmap: await createImageBitmap(blob), decoderPath: "imagebitmap" }
  } catch {
    // Final resort: JS decode (jpeg-js / fast-png, dynamically imported).
    // Reached only on stripped-down execution environments without
    // ImageDecoder or createImageBitmap support — keeps display alive at a
    // high CPU cost.
    return { frame, imageData: await decodeEncodedImage(payload, encoding), decoderPath: "js" }
  }
}

function validateFrame(frame: FrameRectMeta) {
  if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)) throw new Error("invalid frame origin")
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height)) throw new Error("invalid frame size")
  if (frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0) throw new Error("invalid frame bounds")
}

// Reused zlib inflate output buffer. zlib_bgra frames decompress to a full
// width×height×4 surface (~8 MB at 1080p); allocating that per frame churns the
// GC hard on a busy desktop. We inflate into one reused buffer instead, grown
// only when a bigger surface arrives. Safe because the worker decodes frames
// strictly sequentially (the message handler awaits each decodeFrame).
let inflateScratch: Uint8Array | null = null

function ensureInflateScratch(byteLength: number): Uint8Array {
  if (!inflateScratch || inflateScratch.byteLength < byteLength) {
    inflateScratch = new Uint8Array(byteLength)
  }
  return inflateScratch
}

// decodeBgraFrame turns a raw/zlib BGRA surface into an ImageBitmap (GPU-backed,
// freed deterministically via .close() on the main thread) instead of a heap
// ImageData that's transferred and left for the GC. The BGRA→RGBA channel swap
// is done IN PLACE in a buffer we own — the transferred payload for raw_bgra, or
// the reused inflate scratch for zlib_bgra — so no per-frame pixel buffer is
// allocated. createImageBitmap copies the pixels, so the source is free to reuse
// once its promise resolves (which we await before returning).
async function decodeBgraFrame(
  frame: FrameRectMeta,
  payload: Uint8Array,
  gpu: boolean,
): Promise<DecodedFrameOutput> {
  const { width, height } = frame
  const expected = width * height * 4
  // WebGPU fast path: hand back raw BGRA with NO channel swap and NO
  // createImageBitmap — the bgra8unorm texture consumes BGRA directly. raw_bgra
  // can transfer its (owned) payload buffer back zero-copy; zlib_bgra must
  // inflate into a fresh transferable buffer because the inflate scratch is
  // reused across frames and can't be detached.
  if (gpu) {
    if (frame.encoding === "zlib_bgra") {
      const out = new Uint8Array(expected)
      const inflated = unzlibSync(payload, { out })
      if (inflated.length < expected) {
        throw new Error(`zlib BGRA payload too small after inflate: got ${inflated.length}, need ${expected}`)
      }
      return { frame, bgra: out, decoderPath: "imagebitmap" }
    }
    if (payload.length < expected) {
      throw new Error(`raw BGRA payload too small: got ${payload.length}, need ${expected}`)
    }
    // Narrow to exactly `expected` bytes so writeTexture's row math is exact even
    // if the wire payload carried trailing padding.
    const exact = payload.byteLength === expected ? payload : payload.subarray(0, expected)
    return { frame, bgra: exact, decoderPath: "imagebitmap" }
  }
  let bytes: Uint8Array
  if (frame.encoding === "zlib_bgra") {
    const scratch = ensureInflateScratch(expected)
    const out = scratch.byteLength === expected ? scratch : new Uint8Array(scratch.buffer, 0, expected)
    const inflated = unzlibSync(payload, { out })
    if (inflated.length < expected) {
      throw new Error(`zlib BGRA payload too small after inflate: got ${inflated.length}, need ${expected}`)
    }
    bytes = inflated
  } else {
    if (payload.length < expected) {
      throw new Error(`raw BGRA payload too small: got ${payload.length}, need ${expected}`)
    }
    bytes = payload
  }
  // BGRA → RGBA in place: swap B/R, force opaque alpha.
  for (let i = 0; i < expected; i += 4) {
    const b = bytes[i]
    bytes[i] = bytes[i + 2]
    bytes[i + 2] = b
    bytes[i + 3] = 255
  }
  // ImageData requires a Uint8ClampedArray backed by a plain ArrayBuffer. WS
  // payloads always are (never SharedArrayBuffer); narrow the type so the view
  // shares the buffer (no copy) instead of cloning the pixels.
  const rgba = new Uint8ClampedArray(bytes.buffer as ArrayBuffer, bytes.byteOffset, expected)
  const bitmap = await createImageBitmap(new ImageData(rgba, width, height))
  return { frame, bitmap, decoderPath: "imagebitmap" }
}

async function decodeEncodedImage(
  bytes: Uint8Array,
  encoding: Extract<Encoding, "jpeg" | "png">,
): Promise<ImageData> {
  if (encoding === "jpeg") {
    const { decode: decodeJpeg } = await import("jpeg-js")
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

  const { decode: decodePng } = await import("fast-png")
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
