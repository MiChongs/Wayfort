/// <reference lib="webworker" />
import { decode as decodePng } from "fast-png"
import { decompressSync } from "fflate"
import { decode as decodeJpeg } from "jpeg-js"
import { supportsImageDecoder } from "./capabilities"
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
  if (msg.type === "close") return
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

// Whether we've already complained about h264/rfx arriving with no
// decoder wired — keeps the worker log readable when a server flips
// GFX on while the client-side VideoDecoder integration is still
// landing.
let warnedH264 = false
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
    // Wire path lands first; VideoDecoder integration is the next PR.
    // The binary protocol already carries h264 payloads end-to-end so
    // this branch will become the GPU hardware decode path once we
    // add EncodedVideoChunk key/delta typing to the protocol header
    // (libfreerdp's RDPGFX SURFACE_COMMAND has the marker; we just
    // need to thread it through). Until then the gateway only
    // negotiates GFX/H264 when an operator opts in via proto_options
    // (defaults are off), so this throw is what they asked for.
    if (!warnedH264) {
      ctx.postMessage({ type: "warn", message: "h264 frames received but VideoDecoder integration is not yet wired; operator should disable enable_h264 in node options" })
      warnedH264 = true
    }
    throw new Error("h264 decode path not yet implemented; disable enable_h264 in node proto_options")
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
