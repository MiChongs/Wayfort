// Plan 17 frame client. Opens the WebSocket data channel to the gateway,
// posts incoming ServerMessages to the OffscreenCanvas render worker, and
// forwards outgoing ClientMessages over the same WS. The renderer worker
// owns the canvas — this class never touches pixels.

import { getAccessToken } from "@/lib/auth/tokens"
import type { ClientMessage, ServerMessage, SessionStatus } from "./types"

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"

export interface FrameClientOpts {
  sessionId: string
  // Worker that owns the OffscreenCanvas. We post FrameRect/CursorUpdate
  // messages to it; it decodes & paints.
  renderWorker: Worker
  // Surfaces phase + error to the React layer for the toolbar / loader.
  onStatus(status: SessionStatus): void
  // High-level error (transport-level, before SessionStatus is available).
  onError(msg: string): void
}

export class FrameClient {
  private ws: WebSocket | null = null
  private closed = false
  private opts: FrameClientOpts
  private hbTimer: number | null = null

  constructor(opts: FrameClientOpts) {
    this.opts = opts
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
    this.ws.send(JSON.stringify(msg))
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
    } else {
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
    if (msg.bell) {
      // No-op in M1; future plan can play a beep.
      return
    }
  }

  private cleanup(): void {
    if (this.hbTimer != null) {
      window.clearInterval(this.hbTimer)
      this.hbTimer = null
    }
  }

  get isClosed(): boolean {
    return this.closed
  }
}
