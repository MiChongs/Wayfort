// Plan 17 frame client. Opens the WebSocket data channel to the gateway,
// posts incoming ServerMessages to the OffscreenCanvas render worker, and
// forwards outgoing ClientMessages over the same WS. The renderer worker
// owns the canvas — this class never touches pixels.

import { getAccessToken } from "@/lib/auth/tokens"
import type { ClientMessage, ClipboardData, ServerMessage, SessionStatus } from "./types"

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"
const STATS_INTERVAL_MS = 1000

export interface FrameClientStats {
  bytesIn: number
  bytesOut: number
}

export interface FrameClientOpts {
  sessionId: string
  // Worker that owns the OffscreenCanvas. We post FrameRect/CursorUpdate
  // messages to it; it decodes & paints.
  renderWorker: Worker
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
    const token = getAccessToken() ?? ""
    const url = `${WS_BASE}/api/v1/ws/v2/desktop/${this.opts.sessionId}?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url, "desktop.v1")
    ws.binaryType = "arraybuffer"
    this.ws = ws
    ws.addEventListener("open", () => {
      this.opts.onStatus({ phase: "CONNECTING" })
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
      this.handleMessage(ev.data as ArrayBuffer | string)
    })
    ws.addEventListener("error", () => {
      this.opts.onError("WebSocket 错误（网络中断或服务端拒绝）")
    })
    ws.addEventListener("close", (ev) => {
      this.cleanup()
      this.opts.onStatus({
        phase: "CLOSED",
        message: ev.reason || "WebSocket 关闭",
        code: ev.code,
      })
    })
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // M1 wire format is JSON. M1.5 switches to proto + ArrayBuffer.
    const payload = JSON.stringify(msg)
    this._bytesOut += payload.length
    this.ws.send(payload)
  }

  close(): void {
    this.closed = true
    this.cleanup()
    if (this.ws) {
      try {
        this.ws.close(1000, "client closing")
      } catch {
        /* */
      }
      this.ws = null
    }
  }

  private handleMessage(data: ArrayBuffer | string): void {
    let text: string
    if (typeof data === "string") {
      text = data
      this._bytesIn += text.length
    } else {
      this._bytesIn += data.byteLength
      text = new TextDecoder().decode(data)
    }
    let msg: ServerMessage
    try {
      msg = JSON.parse(text) as ServerMessage
    } catch {
      return
    }
    // Status updates go to React; everything else goes to the render
    // worker for decoding + painting (Plan 17.E.1).
    if (msg.status) {
      this.opts.onStatus(msg.status)
      return
    }
    if (msg.frame || msg.cursor) {
      this.opts.renderWorker.postMessage({ type: "server", msg })
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
