import { decode as decodePng } from "fast-png"
import { decode as decodeJpeg } from "jpeg-js"

let installed = false

type CreateImageBitmapLike = typeof window.createImageBitmap

declare global {
  interface Window {
    __guacDecodeImage?: (source: Blob | string) => Promise<HTMLCanvasElement>
  }
}

export function installGuacamoleImageDecoder() {
  if (typeof window === "undefined" || installed) return
  installed = true

  const nativeCreateImageBitmap = window.createImageBitmap?.bind(window)

  window.__guacDecodeImage = async (source) => {
    const blob = typeof source === "string" ? dataURLToBlob(source) : source
    return decodeBlobToCanvas(blob)
  }

  window.createImageBitmap = (async (
    source: ImageBitmapSource,
    ...args: Parameters<CreateImageBitmapLike> extends [ImageBitmapSource, ...infer Rest]
      ? Rest
      : never
  ) => {
    if (!(source instanceof Blob)) {
      if (nativeCreateImageBitmap) return nativeCreateImageBitmap(source, ...args)
      return blankCanvas()
    }

    try {
      if (nativeCreateImageBitmap) {
        return await nativeCreateImageBitmap(source, ...args)
      }
    } catch {
      // Fall through to the JS decoders below. Guacamole 1.5.0 does not catch
      // this rejection and would otherwise leave its render queue blocked.
    }

    try {
      return await decodeBlobToCanvas(source)
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[guac] image decode fallback failed", {
          type: source.type,
          size: source.size,
          error,
        })
      }
      return blankCanvas()
    }
  }) as CreateImageBitmapLike
}

function dataURLToBlob(url: string) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(url)
  if (!match) throw new Error("unsupported image URL")
  const type = match[1] || "application/octet-stream"
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

async function decodeBlobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const kind = imageKind(blob.type, bytes)

  if (kind === "png") {
    const png = decodePng(bytes)
    return rgbaToCanvas(
      normalizePngData(png.data, png.width, png.height, png.channels, png.depth),
      png.width,
      png.height,
    )
  }

  if (kind === "jpeg") {
    const jpeg = decodeJpeg(bytes, {
      colorTransform: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: 256,
      maxResolutionInMP: 64,
      tolerantDecoding: true,
      useTArray: true,
    })
    return rgbaToCanvas(new Uint8ClampedArray(jpeg.data), jpeg.width, jpeg.height)
  }

  throw new Error(`unsupported image mimetype: ${blob.type || "unknown"}`)
}

function imageKind(type: string, bytes: Uint8Array): "png" | "jpeg" | null {
  const mimetype = type.toLowerCase()
  if (mimetype.includes("png")) return "png"
  if (mimetype.includes("jpeg") || mimetype.includes("jpg")) return "jpeg"
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) return "png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg"
  return null
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

function rgbaToCanvas(data: Uint8ClampedArray, width: number, height: number) {
  const canvas = document.createElement("canvas")
  attachImageBitmapClose(canvas)
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("2D canvas context unavailable")
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
  return canvas
}

function blankCanvas() {
  const canvas = document.createElement("canvas")
  attachImageBitmapClose(canvas)
  canvas.width = 1
  canvas.height = 1
  return canvas
}

function attachImageBitmapClose(canvas: HTMLCanvasElement) {
  ;(canvas as HTMLCanvasElement & { close?: () => void }).close = () => {}
}
