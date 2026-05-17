// WebSocket client for the WebSSH / Telnet / DB CLI protocols. The wire format
// is the JSON envelope the backend (internal/webssh/protocol.go) understands:
//   {t:"input",  d:"<base64 bytes from xterm.write>"}
//   {t:"resize", cols, rows}
//   {t:"ping"}
//   server → {t:"output", d:"..."} | {t:"pong"} | {t:"error",msg} | {t:"close"}

import { getAccessToken } from "@/lib/auth/tokens"

export type WSSshHandler = {
  onOutput: (bytes: Uint8Array) => void
  onReady?: () => void
  onClose?: (reason: string) => void
  onError?: (msg: string) => void
}

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"

export class WebSSHConnection {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private path: string, private handlers: WSSshHandler) {}

  open(query: Record<string, string | number | undefined> = {}) {
    const token = getAccessToken() ?? ""
    const qs = new URLSearchParams({ token, ...stringify(query) })
    const ws = new WebSocket(`${WS_BASE}/api/v1${this.path}?${qs}`, ["webssh.v1"])
    this.ws = ws
    ws.binaryType = "arraybuffer"
    ws.onmessage = (ev) => this.handle(ev)
    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.handlers.onClose?.(ev.reason || "closed")
    }
    ws.onerror = () => this.handlers.onError?.("connection error")
    ws.onopen = () => {
      this.pingTimer = setInterval(() => this.send({ t: "ping" }), 30000)
    }
  }

  private handle(ev: MessageEvent) {
    if (typeof ev.data !== "string") return
    let f: Record<string, unknown>
    try { f = JSON.parse(ev.data) } catch { return }
    switch (f.t) {
      case "ready":
        this.handlers.onReady?.()
        break
      case "output":
        if (typeof f.d === "string") {
          const bin = atob(f.d)
          const buf = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
          this.handlers.onOutput(buf)
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
    this.send({ t: "input", d: btoa(unicodeToLatin1(bytes)) })
  }

  resize(cols: number, rows: number) {
    this.send({ t: "resize", cols, rows })
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.ws?.close()
    this.ws = null
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
