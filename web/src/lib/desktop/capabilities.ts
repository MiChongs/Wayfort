// Browser capability probes for the desktop renderer.
//
// The desktop pipeline picks decoder paths at runtime based on what
// the browser actually supports — H.264 via WebCodecs.VideoDecoder
// when available, ImageDecoder for JPEG/PNG when available, otherwise
// the existing createImageBitmap / fast-png / jpeg-js stack.
//
// Two reasons these live in a dedicated module:
//   1. They run in both window scope (SSR-guarded) and inside the
//      DedicatedWorker that owns the decoder. `globalThis` is the
//      portable spelling that works in both.
//   2. The async probe (`probeH264Avc420`) talks to the codec layer
//      and is the only honest way to know if hardware H.264 decode
//      is actually available — Safari's first VideoDecoder revisions
//      shipped the API surface but refused all configurations.

/**
 * Synchronous presence check for WebCodecs.VideoDecoder. Returns true
 * if the global is defined; doesn't guarantee any specific codec
 * actually decodes (use `probeH264Avc420` for that).
 */
export function supportsVideoDecoder(): boolean {
  return typeof globalThis !== "undefined" && "VideoDecoder" in globalThis
}

/**
 * Synchronous presence check for the ImageDecoder API. Same caveat as
 * above — Chromium 94+, Firefox not yet (as of 2026-05), Safari 17+
 * but with quirks on animated formats.
 */
export function supportsImageDecoder(): boolean {
  return typeof globalThis !== "undefined" && "ImageDecoder" in globalThis
}

/**
 * Async probe: ask the codec layer whether AVC420 (H.264 Constrained
 * Baseline level 3.0) can actually decode on this device. RDPGFX only
 * negotiates AVC420 (client.go forces FreeRDP_GfxAVC444 = FALSE) so
 * this codec string is exactly what the pipe will deliver.
 *
 * Result is cached by callers — there's no need to re-probe within a
 * single session.
 */
export async function probeH264Avc420(): Promise<boolean> {
  if (!supportsVideoDecoder()) return false
  try {
    const result = await VideoDecoder.isConfigSupported({
      codec: "avc1.42E01E",
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true,
    })
    return result.supported === true
  } catch {
    return false
  }
}

/**
 * Browser-side capability bag we serialise into the client_caps frame
 * so the worker can decide whether to negotiate GFX/H264 on the RDP
 * channel. `h264` is the async-probed truth; the rest are sync
 * presence checks.
 */
export interface ClientCapabilities {
  h264: boolean
  imageDecoder: boolean
  // Reserved — only true if a future build wires up an rfx decoder.
  // The server currently negotiates RFX when GFX is on, so we tell
  // the server "no" so it picks something we can render.
  rfx: boolean
}

export async function collectClientCapabilities(): Promise<ClientCapabilities> {
  const [h264] = await Promise.all([probeH264Avc420()])
  return {
    h264,
    imageDecoder: supportsImageDecoder(),
    rfx: false,
  }
}
