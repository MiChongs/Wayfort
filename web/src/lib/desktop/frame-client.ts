// Plan 17 frame client. Opens the WebSocket data channel to the gateway,
// decodes desktop.v1 JSON / desktop.v2 binary frames, and forwards outgoing
// ClientMessages over the same WS. The renderer owns canvas painting; this
// class only understands transport framing.

import { getAccessToken } from "@/lib/auth/tokens"
import { collectClientCapabilities } from "./capabilities"
import type {
  ClientMessage,
  ClipboardData,
  CursorEncoding,
  CursorUpdate,
  Encoding,
  FrameBatch,
  FrameRect,
  ServerMessage,
  SessionStatus,
} from "./types"
import type { FrameRectMeta } from "./canvas-renderer"

export interface FrameBytes {
  frame: FrameRectMeta
  payload: Uint8Array
}

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"
const STATS_INTERVAL_MS = 1000
const BINARY_HEADER_SIZE = 32
const BINARY_KIND_JSON = 1
const BINARY_KIND_RECT = 2
const BINARY_KIND_CURSOR = 3
const BINARY_KIND_BATCH = 4
const BINARY_ENCODING_RAW_BGRA = 1
const BINARY_ENCODING_JPEG = 2
const BINARY_ENCODING_PNG = 3
const BINARY_ENCODING_ZLIB_BGRA = 4
// Wire numbers must stay in lockstep with internal/desktop/binary_frame.go
// — the worker emits these byte values and a mismatch silently shows
// blank frames.
const BINARY_ENCODING_H264 = 5
const BINARY_ENCODING_RFX = 6
// BinaryFrameFlagKeyframe — bit 0 of the Flags byte at offset 2 of the
// binary header. Mirrors internal/desktop/binary_frame.go.
const BINARY_FLAG_KEYFRAME = 0x01

export interface FrameClientStats {
  bytesIn: number
  bytesOut: number
}

export interface FrameClientOpts {
  sessionId: string
  // Decoded display events. The renderer owns canvas painting; FrameClient
  // only understands the WebSocket wire format.
  onFrame(frame: FrameRect): void
  onFrameBytes(frame: FrameRectMeta, payload: Uint8Array): void
  onFrameBatch(frames: FrameBytes[]): void
  onCursor(cursor: CursorUpdate): void
  // Surfaces phase + error to the React layer for the toolbar / loader.
  onStatus(status: SessionStatus): void
  // High-level error (transport-level, before SessionStatus is available).
  onError(msg: string): void
  // Plan 17 M2 — remote CLIPRDR data; the component writes text to
  // navigator.clipboard. Image / file-list MIMEs land here too but
  // browser-side handling is M2.x.
  onClipboard?(data: ClipboardData): void
  // Per-second snapshot of cumulative bytes received and sent. Used by the
  // status bar to render ↓ KB / ↑ KB counters without re-rendering on
  // every frame.
  onStats?(stats: FrameClientStats): void
}

export class FrameClient {
  private ws: WebSocket | null = null
  private closed = false
  private opts: FrameClientOpts
  private hbTimer: number | null = null
  private statsTimer: number | null = null
  private _bytesIn = 0
  private _bytesOut = 0
  private decoder = new TextDecoder()

  constructor(opts: FrameClientOpts) {
    this.opts = opts
  }

  get bytesIn(): number {
    return this._bytesIn
  }
  get bytesOut(): number {
    return this._bytesOut
  }

  connect(): void {
    if (this.ws || this.closed) return
    const token = getAccessToken() ?? ""
    const url = `${WS_BASE}/api/v1/ws/v2/desktop/${this.opts.sessionId}?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url, ["desktop.v2", "desktop.v1"])
    ws.binaryType = "arraybuffer"
    this.ws = ws
    ws.addEventListener("open", () => {
      if (this.closed) return
      this.opts.onStatus({ phase: "CONNECTING" })
      // Capability handshake: tell the gateway whether the browser can
      // actually decode H.264 / ImageDecoder before the worker spins
      // up a libfreerdp instance and asks the server to negotiate
      // RDPGFX. `collectClientCapabilities` is async (it probes the
      // codec layer for AVC420 support), but we don't block other
      // sends on it — input messages racing the caps message just
      // arrive in whatever order the WS accepts them, and the worker
      // treats absent caps as "don't enable H.264".
      void collectClientCapabilities().then((caps) => {
        if (this.closed) return
        this.send({ caps })
      })
      // 20s app-level heartbeat keeps middleboxes from idling us out.
      this.hbTimer = window.setInterval(() => {
        this.send({ hb: { ts_ms: Date.now() } })
      }, 20_000)
      if (this.opts.onStats) {
        this.statsTimer = window.setInterval(() => {
          this.opts.onStats?.({ bytesIn: this._bytesIn, bytesOut: this._bytesOut })
        }, STATS_INTERVAL_MS)
      }
    })
    ws.addEventListener("message", (ev) => {
      if (this.closed) return
      this.handleMessage(ev.data as ArrayBuffer | string)
    })
    ws.addEventListener("error", () => {
      if (this.closed) return
      this.opts.onError("WebSocket 错误（网络中断或服务端拒绝）")
    })
    ws.addEventListener("close", (ev) => {
      this.cleanup()
      if (this.closed) return
      this.opts.onStatus({
        phase: "CLOSED",
        message: ev.reason || "WebSocket 关闭",
        code: ev.code,
      })
    })
  }

  send(msg: ClientMessage): void {
    if (this.closed) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // Browser-to-gateway input is still JSON for both desktop.v1 and v2.
    const payload = JSON.stringify(msg)
    this._bytesOut += payload.length
    this.ws.send(payload)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.cleanup()
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      try {
        ws.close(1000, "client closing")
      } catch {
        /* */
      }
    }
  }

  private handleMessage(data: ArrayBuffer | string): void {
    if (data instanceof ArrayBuffer && this.ws?.protocol === "desktop.v2") {
      this._bytesIn += data.byteLength
      this.handleBinaryV2(data)
      return
    }
    let text: string
    if (typeof data === "string") {
      text = data
      this._bytesIn += text.length
    } else {
      this._bytesIn += data.byteLength
      text = this.decoder.decode(data)
    }
    let msg: ServerMessage
    try {
      msg = JSON.parse(text) as ServerMessage
    } catch {
      return
    }
    this.handleServerMessage(msg)
  }

  private handleBinaryV2(data: ArrayBuffer): void {
    if (data.byteLength < BINARY_HEADER_SIZE) return
    const view = new DataView(data)
    const kind = view.getUint8(0)
    const encoding = view.getUint8(1)
    // Byte 2 carries the BinaryFrameFlags bitfield. Bit 0 marks the
    // payload as an H.264 keyframe (IDR + optional SPS/PPS) which the
    // VideoDecoder needs to start a new decode pipeline. Other bits
    // are reserved.
    const flags = view.getUint8(2)
    const keyframe = (flags & BINARY_FLAG_KEYFRAME) !== 0
    const x = view.getUint32(8, false)
    const y = view.getUint32(12, false)
    const width = view.getUint32(16, false)
    const height = view.getUint32(20, false)
    const payloadN = view.getUint32(24, false)
    if (data.byteLength < BINARY_HEADER_SIZE + payloadN) return
    const payload = new Uint8Array(data, BINARY_HEADER_SIZE, payloadN)

    if (kind === BINARY_KIND_JSON) {
      try {
        this.handleServerMessage(JSON.parse(this.decoder.decode(payload)) as ServerMessage)
      } catch {
        /* ignore malformed server frames */
      }
      return
    }

    if (kind === BINARY_KIND_RECT) {
      const frameEncoding = decodeFrameEncoding(encoding)
      if (!frameEncoding) return
      const frame: FrameRectMeta = { x, y, width, height, encoding: frameEncoding, keyframe }
      this.opts.onFrameBytes(frame, payload)
      return
    }

    if (kind === BINARY_KIND_BATCH) {
      const frames = decodeFrameBatchPayload(payload)
      if (frames.length > 0) this.opts.onFrameBatch(frames)
      return
    }

    if (kind === BINARY_KIND_CURSOR) {
      const cursorEncoding = decodeCursorEncoding(encoding)
      if (!cursorEncoding) return
      const cursor: CursorUpdate = {
        hotspot_x: x,
        hotspot_y: y,
        width,
        height,
        encoding: cursorEncoding,
        payload: bytesToBase64(payload),
      }
      this.opts.onCursor(cursor)
    }
  }

  private handleServerMessage(msg: ServerMessage): void {
    // Status updates go to React; frame/cursor updates go to the renderer.
    if (msg.status) {
      this.opts.onStatus(msg.status)
      return
    }
    if (msg.frame || msg.frame_batch || msg.cursor) {
      if (msg.frame) this.opts.onFrame(msg.frame)
      if (msg.frame_batch) this.opts.onFrameBatch(decodeJSONFrameBatch(msg.frame_batch))
      if (msg.cursor) this.opts.onCursor(msg.cursor)
      return
    }
    if (msg.clipboard) {
      // Plan 17 M2: CLIPRDR forwards from worker → gateway → here.
      // text/plain*: write to navigator.clipboard. Other MIMEs (image,
      // file-list) are recognised but not yet plumbed end-to-end.
      this.opts.onClipboard?.(msg.clipboard)
      return
    }
    if (msg.bell) {
      return
    }
  }

  private cleanup(): void {
    if (this.hbTimer != null) {
      window.clearInterval(this.hbTimer)
      this.hbTimer = null
    }
    if (this.statsTimer != null) {
      window.clearInterval(this.statsTimer)
      this.statsTimer = null
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}

function decodeFrameEncoding(value: number): Encoding | null {
  switch (value) {
    case BINARY_ENCODING_RAW_BGRA: return "raw_bgra"
    case BINARY_ENCODING_JPEG:     return "jpeg"
    case BINARY_ENCODING_PNG:      return "png"
    case BINARY_ENCODING_ZLIB_BGRA: return "zlib_bgra"
    case BINARY_ENCODING_H264:     return "h264"
    case BINARY_ENCODING_RFX:      return "rfx"
    default:                       return null
  }
}

function decodeFrameBatchPayload(payload: Uint8Array): FrameBytes[] {
  if (payload.byteLength < 4) return []
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const count = view.getUint32(0, false)
  const frames: FrameBytes[] = []
  let off = 4
  for (let i = 0; i < count; i++) {
    if (payload.byteLength - off < BINARY_HEADER_SIZE) return []
    const itemView = new DataView(payload.buffer, payload.byteOffset + off, BINARY_HEADER_SIZE)
    const kind = itemView.getUint8(0)
    const encoding = itemView.getUint8(1)
    const flags = itemView.getUint8(2)
    const keyframe = (flags & BINARY_FLAG_KEYFRAME) !== 0
    const x = itemView.getUint32(8, false)
    const y = itemView.getUint32(12, false)
    const width = itemView.getUint32(16, false)
    const height = itemView.getUint32(20, false)
    const payloadN = itemView.getUint32(24, false)
    off += BINARY_HEADER_SIZE
    if (kind !== BINARY_KIND_RECT) return []
    const frameEncoding = decodeFrameEncoding(encoding)
    if (!frameEncoding) return []
    const end = off + payloadN
    if (end < off || end > payload.byteLength) return []
    frames.push({
      frame: { x, y, width, height, encoding: frameEncoding, keyframe },
      payload: payload.subarray(off, end),
    })
    off = end
  }
  return off === payload.byteLength ? frames : []
}

function decodeJSONFrameBatch(batch: FrameBatch): FrameBytes[] {
  return batch.frames.map((frame) => ({
    frame,
    payload: bytesFromFramePayload(frame.payload),
  }))
}

function bytesFromFramePayload(payload: string): Uint8Array {
  const bin = atob(payload)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeCursorEncoding(value: number): CursorEncoding | null {
  switch (value) {
    case BINARY_ENCODING_RAW_BGRA: return "raw_bgra"
    case BINARY_ENCODING_PNG:      return "png"
    default:                       return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
