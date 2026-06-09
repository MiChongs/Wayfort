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
 * Synchronous check for the WebRTC video path: an RTCPeerConnection must exist
 * and the receiver must list VP8 among its decodable codecs. VP8 is WebRTC's
 * mandatory-to-implement codec, so any browser with RTCPeerConnection decodes
 * it — the getCapabilities check is just a stronger guarantee where available.
 */
export function supportsWebRTCVP8(): boolean {
  const g = globalThis as unknown as {
    RTCPeerConnection?: unknown
    RTCRtpReceiver?: { getCapabilities?: (kind: string) => { codecs?: { mimeType?: string }[] } | null }
  }
  if (typeof g === "undefined" || typeof g.RTCPeerConnection === "undefined") return false
  try {
    const caps = g.RTCRtpReceiver?.getCapabilities?.("video")
    if (!caps || !Array.isArray(caps.codecs)) return true // PC exists; assume VP8
    return caps.codecs.some((c) => (c.mimeType ?? "").toLowerCase() === "video/vp8")
  } catch {
    return true
  }
}

/**
 * Whether the browser can decode a VP9 WebRTC track. Unlike VP8 (assumed when a
 * PeerConnection exists), VP9 is only reported when `getCapabilities` explicitly
 * lists it — VP9's screen-content decode is what makes the sharper desktop codec
 * worth selecting, so we don't guess. The gateway uses this to pick VP9 over VP8.
 */
export function supportsWebRTCVP9(): boolean {
  const g = globalThis as unknown as {
    RTCPeerConnection?: unknown
    RTCRtpReceiver?: { getCapabilities?: (kind: string) => { codecs?: { mimeType?: string }[] } | null }
  }
  if (typeof g === "undefined" || typeof g.RTCPeerConnection === "undefined") return false
  if (typeof g.RTCRtpReceiver?.getCapabilities !== "function") return false
  try {
    const caps = g.RTCRtpReceiver.getCapabilities("video")
    return !!caps?.codecs?.some((c) => (c.mimeType ?? "").toLowerCase() === "video/vp9")
  } catch {
    return false
  }
}

/**
 * Whether the browser can decode an AV1 WebRTC track. Only reported when
 * `getCapabilities` explicitly lists AV1 — AV1's screen-content coding is the
 * most bandwidth-efficient option, but it's only worth selecting when the
 * receiver can actually decode it (and the node opted in). The gateway uses this
 * to pick AV1 over VP9/VP8.
 */
export function supportsWebRTCAV1(): boolean {
  const g = globalThis as unknown as {
    RTCPeerConnection?: unknown
    RTCRtpReceiver?: { getCapabilities?: (kind: string) => { codecs?: { mimeType?: string }[] } | null }
  }
  if (typeof g === "undefined" || typeof g.RTCPeerConnection === "undefined") return false
  if (typeof g.RTCRtpReceiver?.getCapabilities !== "function") return false
  try {
    const caps = g.RTCRtpReceiver.getCapabilities("video")
    return !!caps?.codecs?.some((c) => (c.mimeType ?? "").toLowerCase() === "video/av1")
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
/**
 * Probe whether the bundled zstd-wasm decoder actually loads and round-trips on
 * this device. We compress+decompress a tiny vector through the WASM so a broken
 * wasm fetch / instantiation reports `false` and the server stays on zlib_bgra,
 * rather than the server emitting zstd_bgra the worker can't inflate (which would
 * break every lossless frame). Cached by the caller, like probeH264Avc420.
 */
export async function probeZstd(): Promise<boolean> {
  try {
    const { init, compress, decompress } = await import("@bokuweb/zstd-wasm")
    await init()
    const test = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const round = decompress(compress(test, 1))
    return round.length === test.length && round[0] === 1 && round[7] === 8
  } catch {
    return false
  }
}

export interface ClientCapabilities {
  h264: boolean
  imageDecoder: boolean
  // zstd reports the bundled zstd-wasm decoder loads + round-trips here. When
  // true the worker emits zstd_bgra (faster decode + smaller) for lossless rects.
  zstd: boolean
  // Reserved — only true if a future build wires up an rfx decoder.
  // The server currently negotiates RFX when GFX is on, so we tell
  // the server "no" so it picks something we can render.
  rfx: boolean
  // webrtc enables the gateway's hardware-decoded video path. When false,
  // the session uses the legacy WS bitmap path.
  webrtc: boolean
  // webrtcVP9 lets the gateway pick VP9's screen-content codec (sharper desktop
  // text/UI) over VP8. False → VP8.
  webrtcVP9: boolean
  // webrtcAV1 lets the gateway pick AV1 (most bandwidth-efficient) when the node
  // opted in (rdp.prefer_av1). False → VP9/VP8.
  webrtcAV1: boolean
}

export async function collectClientCapabilities(): Promise<ClientCapabilities> {
  const [h264, zstd] = await Promise.all([probeH264Avc420(), probeZstd()])
  return {
    h264,
    imageDecoder: supportsImageDecoder(),
    zstd,
    rfx: false,
    webrtc: supportsWebRTCVP8(),
    webrtcVP9: supportsWebRTCVP9(),
    webrtcAV1: supportsWebRTCAV1(),
  }
}
