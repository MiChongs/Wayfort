// Port-forward live events client. Mirrors the desktop frame-client WS
// lifecycle: open with bearer token in query string, send a 20 s heartbeat,
// reconnect with exponential back-off when the socket drops. The gateway
// streams JSON envelopes describing forwarder lifecycle and per-tick byte
// rates (see internal/protocols/tcpfwd/events.go for the wire schema).

import { getAccessToken } from "@/lib/auth/tokens"

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000]
const HEARTBEAT_INTERVAL_MS = 20_000

export type PortForwardEventType =
  | "opened"
  | "closed"
  | "error"
  | "bytes_tick"
  | "conn_open"
  | "conn_close"
  | "metadata"
  | "hb"

export interface PortForwardEvent {
  type: PortForwardEventType
  forward_id: string
  user_id: number
  ts_ms: number
  // bytes_tick fields
  bytes_in?: number
  bytes_out?: number
  in_rate_bps?: number
  out_rate_bps?: number
  active_conns?: number
  // error
  error_message?: string
}

export interface PortForwardEventsClientOpts {
  // Called for every server-pushed event.
  onEvent(event: PortForwardEvent): void
  // Round-trip latency between heartbeat send and echo, in ms. Called once
  // per heartbeat round-trip. Optional consumer.
  onLatency?(rttMs: number): void
  // High-level connection state for UI status indicators.
  onStatus?(status: "connecting" | "open" | "closed" | "error"): void
}

export class PortForwardEventsClient {
  private opts: PortForwardEventsClientOpts
  private ws: WebSocket | null = null
  private closed = false
  private reconnectAttempt = 0
  private reconnectTimer: number | null = null
  private hbTimer: number | null = null
  private encoder = new TextEncoder()

  constructor(opts: PortForwardEventsClientOpts) {
    this.opts = opts
  }

  start(): void {
    if (this.closed) return
    this.opts.onStatus?.("connecting")
    const token = getAccessToken() ?? ""
    const url = `${WS_BASE}/api/v1/ws/portforward/events?token=${encodeURIComponent(token)}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      this.opts.onStatus?.("error")
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener("open", () => {
      if (this.closed) {
        ws.close()
        return
      }
      this.reconnectAttempt = 0
      this.opts.onStatus?.("open")
      this.hbTimer = window.setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS)
    })

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      let payload: PortForwardEvent
      try {
        payload = JSON.parse(event.data) as PortForwardEvent
      } catch {
        return
      }
      if (payload.type === "hb") {
        if (typeof payload.ts_ms === "number" && this.opts.onLatency) {
          this.opts.onLatency(Math.max(0, Date.now() - payload.ts_ms))
        }
        return
      }
      this.opts.onEvent(payload)
    })

    ws.addEventListener("error", () => {
      this.opts.onStatus?.("error")
    })

    ws.addEventListener("close", () => {
      this.clearHeartbeat()
      this.ws = null
      if (this.closed) {
        this.opts.onStatus?.("closed")
        return
      }
      this.opts.onStatus?.("closed")
      this.scheduleReconnect()
    })

    // Silence "unused" warning for the encoder; reserved for future binary
    // subscribe frames (e.g. filter by forward_id list).
    void this.encoder
  }

  stop(): void {
    this.closed = true
    this.clearHeartbeat()
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
  }

  private clearHeartbeat() {
    if (this.hbTimer !== null) {
      window.clearInterval(this.hbTimer)
      this.hbTimer = null
    }
  }

  private sendHeartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify({ hb: { ts_ms: Date.now() } }))
    } catch {
      /* dropped sends are recovered by the next heartbeat or reconnect */
    }
  }

  private scheduleReconnect() {
    if (this.closed) return
    const idx = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
    const delay = RECONNECT_BACKOFF_MS[idx]
    this.reconnectAttempt++
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.start()
    }, delay)
  }
}
