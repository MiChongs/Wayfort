// WebSocket client for the WebSSH / Telnet / DB CLI protocols. The wire format
// is the JSON envelope the backend (internal/webssh/protocol.go) understands:
//   {t:"input",  d:"<base64 bytes from xterm.write>"}
//   {t:"resize", cols, rows}
//   {t:"ping"}
//   server → {t:"output", d:"..."} | {t:"pong"} | {t:"error",msg} | {t:"close"}

import { getAccessToken } from "@/lib/auth/tokens"

export interface SessionStats {
  bytesIn: number
  bytesOut: number
}

export type WSSshHandler = {
  onOutput: (bytes: Uint8Array) => void
  onReady?: () => void
  onClose?: (reason: string) => void
  onError?: (msg: string) => void
  // Optional callbacks added in the v2 terminal — the status bar uses them
  // to surface bytes counters and round-trip latency. Both fire at most a
  // few times per second so there's no need to debounce in the consumer.
  onStats?: (stats: SessionStats) => void
  onLatency?: (ms: number) => void
}

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"
const PING_INTERVAL_MS = 5000

export class WebSSHConnection {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pendingPingAt: number | null = null
  private _bytesIn = 0
  private _bytesOut = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null

  constructor(private path: string, private handlers: WSSshHandler) {}

  open(query: Record<string, string | number | undefined> = {}) {
    const token = getAccessToken() ?? ""
    const qs = new URLSearchParams({ token, ...stringify(query) })
    const ws = new WebSocket(`${WS_BASE}/api/v1${this.path}?${qs}`, ["webssh.v1"])
    this.ws = ws
    ws.binaryType = "arraybuffer"
    ws.onmessage = (ev) => this.handle(ev)
    ws.onclose = (ev) => {
      this.stopTimers()
      this.handlers.onClose?.(ev.reason || "closed")
    }
    ws.onerror = () => this.handlers.onError?.("connection error")
    ws.onopen = () => {
      this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS)
      // Stats poll publishes the byte counters at a sane cadence so the UI
      // doesn't redraw on every keystroke. 1Hz is fast enough to feel live
      // and slow enough to be invisible in the React render profile.
      if (this.handlers.onStats) {
        this.statsTimer = setInterval(() => {
          this.handlers.onStats?.({ bytesIn: this._bytesIn, bytesOut: this._bytesOut })
        }, 1000)
      }
    }
  }

  private sendPing() {
    // Only one outstanding ping at a time — if the server's pong didn't come
    // back yet, the previous round-trip count is still pending; don't reset
    // the clock or you'll under-report latency on flaky links.
    if (this.pendingPingAt !== null) return
    this.pendingPingAt = performance.now()
    this.send({ t: "ping" })
  }

  private handle(ev: MessageEvent) {
    if (typeof ev.data !== "string") return
    let f: Record<string, unknown>
    try {
      f = JSON.parse(ev.data)
    } catch {
      return
    }
    switch (f.t) {
      case "ready":
        this.handlers.onReady?.()
        break
      case "output":
        if (typeof f.d === "string") {
          const bin = atob(f.d)
          const buf = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
          this._bytesIn += buf.length
          this.handlers.onOutput(buf)
        }
        break
      case "pong":
        if (this.pendingPingAt !== null) {
          const ms = Math.round(performance.now() - this.pendingPingAt)
          this.pendingPingAt = null
          this.handlers.onLatency?.(ms)
        }
        break
      case "error":
        this.handlers.onError?.(String(f.msg ?? "unknown"))
        break
      case "close":
        this.handlers.onClose?.(String(f.msg ?? ""))
        break
    }
  }

  sendInput(bytes: string) {
    const encoded = unicodeToLatin1(bytes)
    this._bytesOut += encoded.length
    this.send({ t: "input", d: btoa(encoded) })
  }

  resize(cols: number, rows: number) {
    this.send({ t: "resize", cols, rows })
  }

  close() {
    this.stopTimers()
    this.ws?.close()
    this.ws = null
  }

  private stopTimers() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
  }

  get bytesIn() {
    return this._bytesIn
  }

  get bytesOut() {
    return this._bytesOut
  }

  private send(frame: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(frame))
  }
}

function stringify(q: Record<string, string | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(q)) if (v !== undefined) out[k] = String(v)
  return out
}

// UTF-8 → byte string for btoa. xterm sends keystrokes as UTF-8 codepoints.
function unicodeToLatin1(s: string): string {
  return String.fromCharCode(...new TextEncoder().encode(s))
}
