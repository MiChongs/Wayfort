/// <reference types="@webgpu/types" />
//
// WebGPU rendering surface for the legacy FreeRDP/dummy desktop bitmap path.
//
// Why this exists (the operator-visible win): the Canvas 2D path pays two
// avoidable costs per BGRA surface rect on a busy VDI desktop —
//   1. a per-pixel BGRA→RGBA channel swap on the CPU (decode worker), and
//   2. a createImageBitmap() that copies the whole surface into a GPU bitmap,
// then one drawImage() per rect on the main thread.
// WebGPU lets us skip BOTH: a `bgra8unorm` texture consumes the raw BGRA bytes
// the wire already carries (no swap), uploaded straight to the GPU via
// queue.writeTexture (no intermediate ImageBitmap). All dirty rects of a batch
// accumulate into one persistent framebuffer texture, then a single
// copyTextureToTexture presents the whole frame — no shaders, no per-rect draw
// calls. That cuts main-thread CPU, GC churn and memory, which is exactly the
// "浏览器卡 / 烫 / 占内存高" pain on high-load sessions.
//
// Safety: this is strictly additive. createWebGPUSurface() returns null on ANY
// failure (no navigator.gpu, adapter/device request fails, canvas configure
// throws) so the renderer falls back to the proven Canvas 2D path with zero
// behavioural change. A canvas can only hold ONE context kind, so the choice is
// made once at renderer creation — never switched mid-session.

// SurfacePaintItem is one decoded rectangle ready to composite. Exactly one of
// bgra / bitmap / imageData is set:
//   bgra      — raw BGRA bytes (width*height*4), the fast path; written directly
//               into the bgra8unorm framebuffer with no channel swap.
//   bitmap    — an ImageBitmap (H.264 / JPEG / PNG decode output) or VideoFrame.
//   imageData — RGBA pixels from the pure-JS fallback decoders.
export interface SurfacePaintItem {
  x: number
  y: number
  width: number
  height: number
  bgra?: Uint8Array
  bitmap?: ImageBitmap
  imageData?: ImageData
}

// DesktopSurface is the small abstraction the renderer paints through. Two
// implementations exist: this WebGPU one and the Canvas 2D one inlined in
// canvas-renderer.ts. `wantsRawBGRA` tells the decode worker whether to hand
// back raw BGRA bytes (WebGPU) or a pre-swapped ImageBitmap (Canvas 2D).
export interface DesktopSurface {
  readonly kind: "webgpu" | "canvas2d"
  readonly wantsRawBGRA: boolean
  resize(width: number, height: number): void
  paint(item: SurfacePaintItem): void
  present(): void
  destroy(): void
}

// copyExternalImageToTexture requires the source to be one of a fixed set of
// image-bearing types. ImageBitmap covers the H.264/JPEG/PNG decode outputs;
// ImageData covers the JS-fallback path (allowed by the WebGPU spec).
type ExternalImageSource = ImageBitmap | ImageData

// We force the framebuffer + canvas to bgra8unorm so the raw-BGRA writeTexture
// path needs no channel swap, and present is a plain copyTextureToTexture
// (matching formats, no render pipeline). copyExternalImageToTexture handles the
// RGBA→BGRA mapping for bitmap/imageData sources into the same format.
const SURFACE_FORMAT: GPUTextureFormat = "bgra8unorm"
const FB_USAGE =
  GPUTextureUsage.COPY_SRC |
  GPUTextureUsage.COPY_DST |
  GPUTextureUsage.RENDER_ATTACHMENT |
  GPUTextureUsage.TEXTURE_BINDING

export async function createWebGPUSurface(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  onError?: (message: string) => void,
): Promise<DesktopSurface | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu) return null

  let device: GPUDevice | null = null
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" })
    if (!adapter) return null
    device = await adapter.requestDevice()
    if (!device) return null
  } catch (error) {
    onError?.(`webgpu adapter/device unavailable, using canvas2d: ${String(error)}`)
    try {
      device?.destroy()
    } catch {
      /* ignore */
    }
    return null
  }

  const contextConfig: GPUCanvasConfiguration = {
    device,
    format: SURFACE_FORMAT,
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    alphaMode: "opaque",
  }

  // getContext("webgpu") permanently locks the canvas to the WebGPU context kind
  // — after it, getContext("2d") returns null forever. So validate the full
  // configure on a THROWAWAY 1×1 canvas first; only if that succeeds do we touch
  // the real canvas. This guarantees a configure failure can never strand the
  // real canvas in an unusable state and block the Canvas 2D fallback.
  try {
    const probe = document.createElement("canvas")
    probe.width = 1
    probe.height = 1
    const probeCtx = probe.getContext("webgpu")
    if (!probeCtx) {
      device.destroy()
      return null
    }
    probeCtx.configure(contextConfig)
    probeCtx.unconfigure()
  } catch (error) {
    onError?.(`webgpu configure probe failed, using canvas2d: ${String(error)}`)
    try {
      device.destroy()
    } catch {
      /* ignore */
    }
    return null
  }

  // Probe passed — the same configure is guaranteed to work on the real canvas
  // (devices aren't canvas-bound; only the size differs, which configure ignores).
  let context: GPUCanvasContext | null = null
  try {
    context = canvas.getContext("webgpu")
    if (!context) {
      device.destroy()
      return null
    }
    context.configure(contextConfig)
  } catch (error) {
    onError?.(`webgpu canvas configure failed: ${String(error)}`)
    try {
      device.destroy()
    } catch {
      /* ignore */
    }
    return null
  }

  const dev = device
  const ctx = context
  let fbW = Math.max(1, Math.floor(width))
  let fbH = Math.max(1, Math.floor(height))
  let framebuffer = createFramebuffer(dev, fbW, fbH)
  // True once the device is lost / a submit throws — we stop touching the GPU so
  // a dead device can't spam errors. Frames silently drop (the session is
  // already degraded); the operator-visible signal is the frozen canvas.
  let broken = false

  // A device-lost event is terminal for this surface. Mark broken so paint /
  // present become no-ops instead of throwing on every frame.
  void dev.lost.then((info) => {
    broken = true
    onError?.(`webgpu device lost: ${info?.reason ?? "unknown"} ${info?.message ?? ""}`.trim())
  })

  function createFramebufferAndCopy(newW: number, newH: number) {
    const next = createFramebuffer(dev, newW, newH)
    // Preserve the overlap so unchanged regions survive a resize (RDP only
    // repaints dirty rects; without this the desktop would flash on every
    // window resize until the server happens to repaint each area).
    const copyW = Math.min(fbW, newW)
    const copyH = Math.min(fbH, newH)
    if (copyW > 0 && copyH > 0) {
      const enc = dev.createCommandEncoder()
      enc.copyTextureToTexture(
        { texture: framebuffer },
        { texture: next },
        { width: copyW, height: copyH, depthOrArrayLayers: 1 },
      )
      dev.queue.submit([enc.finish()])
    }
    framebuffer.destroy()
    framebuffer = next
    fbW = newW
    fbH = newH
  }

  return {
    kind: "webgpu",
    wantsRawBGRA: true,
    resize(w: number, h: number) {
      if (broken) return
      const nextW = Math.max(1, Math.floor(w))
      const nextH = Math.max(1, Math.floor(h))
      if (nextW === fbW && nextH === fbH) return
      // The canvas element's backing store is sized by the renderer; the WebGPU
      // context tracks it automatically, but the offscreen framebuffer we
      // accumulate into must be recreated to the new size.
      try {
        createFramebufferAndCopy(nextW, nextH)
      } catch (error) {
        broken = true
        onError?.(`webgpu resize failed: ${String(error)}`)
      }
    },
    paint(item: SurfacePaintItem) {
      if (broken) return
      const w = Math.max(1, Math.min(item.width, fbW - item.x))
      const h = Math.max(1, Math.min(item.height, fbH - item.y))
      if (item.x < 0 || item.y < 0 || item.x >= fbW || item.y >= fbH) return
      try {
        if (item.bgra) {
          // Fast path: raw BGRA straight into the bgra8unorm texture, no swap,
          // no ImageBitmap. writeTexture from a CPU buffer has no bytesPerRow
          // 256-alignment requirement (that's buffer→texture copies only).
          dev.queue.writeTexture(
            { texture: framebuffer, origin: { x: item.x, y: item.y } },
            item.bgra as BufferSource,
            { offset: 0, bytesPerRow: item.width * 4, rowsPerImage: item.height },
            { width: w, height: h, depthOrArrayLayers: 1 },
          )
        } else {
          const source: ExternalImageSource | undefined = item.bitmap ?? item.imageData
          if (!source) return
          dev.queue.copyExternalImageToTexture(
            { source, flipY: false },
            { texture: framebuffer, origin: { x: item.x, y: item.y }, premultipliedAlpha: false },
            { width: w, height: h },
          )
          item.bitmap?.close()
        }
      } catch (error) {
        broken = true
        onError?.(`webgpu paint failed: ${String(error)}`)
      }
    },
    present() {
      if (broken) return
      try {
        const dst = ctx.getCurrentTexture()
        const enc = dev.createCommandEncoder()
        // Both framebuffer and swapchain are bgra8unorm, so a straight texture
        // copy presents the accumulated frame — no render pipeline / shader.
        enc.copyTextureToTexture(
          { texture: framebuffer },
          { texture: dst },
          { width: Math.min(fbW, dst.width), height: Math.min(fbH, dst.height), depthOrArrayLayers: 1 },
        )
        dev.queue.submit([enc.finish()])
      } catch (error) {
        broken = true
        onError?.(`webgpu present failed: ${String(error)}`)
      }
    },
    destroy() {
      broken = true
      try {
        framebuffer.destroy()
      } catch {
        /* ignore */
      }
      try {
        ctx.unconfigure()
      } catch {
        /* ignore */
      }
      try {
        dev.destroy()
      } catch {
        /* ignore */
      }
    },
  }
}

function createFramebuffer(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: SURFACE_FORMAT,
    usage: FB_USAGE,
  })
}
