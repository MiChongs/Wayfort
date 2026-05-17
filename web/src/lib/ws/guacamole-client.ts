"use client"

// Guacamole client adapter. Three previous attempts and what was wrong:
//   1. CDN <script> at jsDelivr → wrong version (1.6.0 didn't exist) → 404.
//   2. Dynamic `import("guacamole-common-js")` → Turbopack emitted only an
//      SSR chunk; browser saw "Cannot find module".
//   3. Static `import GuacamoleNS from "guacamole-common-js"` inside a
//      "use client" module → bundler split the library into 5 chunks +
//      tree-shook, but the library has 34 `var Guacamole = Guacamole || {}`
//      top-level redeclarations that each chunk treated as separate scope.
//      Result: WebSocketTunnel and Tunnel parser disagreed on the same
//      `Guacamole` object → `RangeError: Invalid array length` when a
//      message length led to a bogus array allocation.
//
// Final approach: serve the pre-built UMD-ish single file (the same
// `guacamole-common.min.js` shipped in the npm package's CJS dist) as a
// Next.js static asset from `/vendor/...`. Inject a real <script> tag at
// runtime, wait for `window.Guacamole` to populate, then use the global.
// One file, one global, zero bundler magic.
//
// Plan 13.C — robustness pass:
//   - Wrap synchronous `client.connect()` in try/catch and surface the error
//     via opts.onError. Previously a throw silently broke the state machine.
//   - Register `tunnel.onerror` independently of `client.onerror`: tunnel
//     errors (WS dial failure, server close mid-stream) don't always
//     propagate to client.onerror in older library builds.
//   - Diagnostic console.debug for state transitions when NODE_ENV !== "production".
//   - Wire up clipboard (RDP/VNC ↔ browser) via Guacamole.StringReader/Writer.
//   - Wire up touch input (Guacamole.Touch) for tablet support.
//   - Optional bandwidth-in metric via tunnel.oninstruction chaining.
//   - Optional liveness metric via client.onsync timing — "ms since last sync"
//     is our proxy for server-perceived latency.

import { getAccessToken } from "@/lib/auth/tokens"

const WS_BASE =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"

// Bumped path includes ?v= to bust stale browser cache when we eventually
// upgrade the vendored library.
const VENDOR_URL = "/vendor/guacamole-common.min.js?v=1.5.0"

const DEBUG = process.env.NODE_ENV !== "production"
function dbg(...args: unknown[]) {
  if (DEBUG) {
    // Keep namespace-prefixed so it stands out in DevTools.
    // eslint-disable-next-line no-console
    console.debug("[guac]", ...args)
  }
}

type GuacNS = {
  Client: new (tunnel: unknown) => GuacClientLike
  WebSocketTunnel: new (url: string) => GuacTunnelLike
  Mouse: new (el: HTMLElement) => GuacMouseLike
  Keyboard: new (target: Document | HTMLElement) => GuacKeyboardLike
  Touch?: new (el: HTMLElement) => GuacTouchLike
  StringReader?: new (stream: unknown) => GuacStringReader
  StringWriter?: new (stream: unknown) => GuacStringWriter
  Status: {
    Code: Record<string, number>
  }
}

interface GuacTunnelLike {
  onerror?: (status: { code?: number; message?: string }) => void
  onstatechange?: (s: number) => void
  oninstruction?: (opcode: string, params: string[]) => void
  disconnect?: () => void
}

interface GuacClientLike {
  onerror?: (status: { code?: number; message?: string }) => void
  onstatechange?: (state: number) => void
  onclipboard?: (stream: unknown, mimetype: string) => void
  onsync?: (timestamp: number) => void
  getDisplay(): {
    getElement(): HTMLElement
    resize(layer: unknown, w: number, h: number): void
    getDefaultLayer(): unknown
    onresize?: (w: number, h: number) => void
  }
  sendMouseState(state: unknown): void
  sendKeyEvent(pressed: number, keysym: number): void
  sendSize(w: number, h: number): void
  createClipboardStream?: (mimetype: string) => unknown
  connect(params: string): void
  disconnect(): void
}
interface GuacMouseLike {
  onmousedown?: (s: unknown) => void
  onmouseup?: (s: unknown) => void
  onmousemove?: (s: unknown) => void
}
interface GuacKeyboardLike {
  onkeydown?: (k: number) => void
  onkeyup?: (k: number) => void
}
interface GuacTouchLike {
  onmousedown?: (s: unknown) => void
  onmouseup?: (s: unknown) => void
  onmousemove?: (s: unknown) => void
}
interface GuacStringReader {
  ontext?: (t: string) => void
  onend?: () => void
}
interface GuacStringWriter {
  sendText(t: string): void
  sendEnd(): void
}

let scriptPromise: Promise<GuacNS> | null = null

export async function ensureGuacamoleScript(): Promise<GuacNS> {
  if (typeof window === "undefined") {
    throw new Error("guacamole only runs in the browser")
  }
  const w = window as unknown as { Guacamole?: GuacNS }
  if (w.Guacamole && typeof w.Guacamole.Client === "function") {
    return w.Guacamole
  }
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<GuacNS>((resolve, reject) => {
    // Idempotency: if another component already injected the tag, reuse it.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-guacamole]`,
    )
    const tag = existing ?? document.createElement("script")
    if (!existing) {
      tag.src = VENDOR_URL
      tag.async = true
      tag.dataset.guacamole = "1"
    }
    function done() {
      const g = (window as unknown as { Guacamole?: GuacNS }).Guacamole
      if (g && typeof g.Client === "function") {
        resolve(g)
      } else {
        reject(new Error("guacamole-common.min.js loaded but window.Guacamole is missing"))
      }
    }
    function fail(reason: string) {
      scriptPromise = null
      reject(new Error(reason))
    }
    tag.addEventListener("load", done, { once: true })
    tag.addEventListener("error", () => fail(`failed to fetch ${VENDOR_URL}`), {
      once: true,
    })
    if (!existing) document.head.appendChild(tag)
  })
  return scriptPromise
}

export type GuacQuality = "auto" | "high" | "medium" | "low"

export interface GuacMetrics {
  // ms since the last `sync` instruction was received from guacd. High
  // values (>2000ms) indicate the server is starved or the network is
  // congested. Used as our latency proxy since the WS API doesn't expose
  // pong timing to JS.
  lastSyncAgeMs?: number
  // Bandwidth received from guacd, byte/sec, computed over a 1s window.
  bytesPerSecIn?: number
  // Total bytes received since connect.
  bytesIn?: number
}

export type GuacOpts = {
  protocol: "rdp" | "vnc"
  nodeId: number
  width: number
  height: number
  dpi?: number
  container: HTMLElement
  // Plan 13.B.2/3: client-driven knobs forwarded to the gateway as query
  // params. The gateway translates them into guacd connect parameters.
  quality?: GuacQuality
  enableAudio?: boolean
  enableClipboard?: boolean
  keyboardLayout?: string
  onStateChange?: (state: number) => void
  onError?: (err: { code?: number; message: string }) => void
  onDisplayResize?: (w: number, h: number) => void
  // Plan 13.D.6: invoked when the remote sends clipboard data so the
  // browser can write it to navigator.clipboard.
  onRemoteClipboard?: (text: string) => void
  // Plan 13.D.1/D.2/D.3: periodic metrics for the toolbar (1Hz updates).
  onMetrics?: (m: GuacMetrics) => void
}

export interface GuacHandle {
  disconnect(): void
  sendResize(w: number, h: number): void
  sendCtrlAltDel(): void
  // Plan 13.D.6: push local clipboard text to the remote desktop.
  pushClipboard(text: string): void
  client: GuacClientLike
}

const KEYSYMS = {
  Ctrl: 0xffe3,
  Alt: 0xffe9,
  Delete: 0xffff,
}

// buildConnectURL serialises the full WS URL including the new feature
// toggles. The backend gateway reads these via c.Query().
function buildConnectURL(opts: GuacOpts): string {
  const token = getAccessToken() ?? ""
  const params = new URLSearchParams({
    token,
    width: String(opts.width),
    height: String(opts.height),
    dpi: String(opts.dpi ?? 96),
  })
  if (opts.quality) params.set("quality", opts.quality)
  if (opts.enableAudio !== undefined)
    params.set("audio", opts.enableAudio ? "1" : "0")
  if (opts.enableClipboard !== undefined)
    params.set("clipboard", opts.enableClipboard ? "1" : "0")
  if (opts.keyboardLayout) params.set("keyboard", opts.keyboardLayout)
  return `${WS_BASE}/api/v1/ws/${opts.protocol}/${opts.nodeId}?${params.toString()}`
}

export async function connectGuacamole(opts: GuacOpts): Promise<GuacHandle> {
  const G = await ensureGuacamoleScript()
  const url = buildConnectURL(opts)
  dbg("connect", { url: url.replace(/token=[^&]*/, "token=***"), opts: { ...opts, container: "<el>" } })
  const tunnel = new G.WebSocketTunnel(url)
  const client = new G.Client(tunnel)

  // Plan 13.C.1 — register tunnel.onerror BEFORE client setup so transport
  // failures during the WS dial are visible. Some old guacamole-common-js
  // builds don't relay tunnel errors through client.onerror.
  tunnel.onerror = (status) => {
    dbg("tunnel error", status)
    opts.onError?.({
      code: status?.code,
      message: status?.message || `tunnel error (code=${status?.code ?? "?"})`,
    })
  }
  tunnel.onstatechange = (s) => dbg("tunnel state ->", s)

  client.onerror = (status) => {
    dbg("client error", status)
    opts.onError?.({
      code: status?.code,
      message: status?.message || `guac error (code=${status?.code ?? "?"})`,
    })
  }
  client.onstatechange = (s) => {
    dbg("client state ->", s)
    opts.onStateChange?.(s)
  }

  // Plan 13.D.6 — remote → local clipboard. The Guacamole protocol exposes
  // clipboard data as a stream; we accumulate text/* and hand it to the
  // browser. Anything non-text (image/png from RDP screenshots, etc.) is
  // ignored for now.
  client.onclipboard = (stream, mimetype) => {
    if (!mimetype || !mimetype.startsWith("text/")) return
    if (!G.StringReader) return
    const reader = new G.StringReader(stream)
    let acc = ""
    reader.ontext = (t: string) => {
      acc += t
    }
    reader.onend = () => {
      if (!acc) return
      dbg("remote clipboard", acc.length, "chars")
      opts.onRemoteClipboard?.(acc)
    }
  }

  // Plan 13.D.2 — liveness via sync timing. guacd emits sync ~60Hz during
  // active rendering, slower when idle. Track last sync wall-clock time so
  // the metrics tick can compute the age.
  let lastSyncAt = Date.now()
  client.onsync = (_timestamp: number) => {
    lastSyncAt = Date.now()
  }

  const displayCtl = client.getDisplay()
  const display = displayCtl.getElement()
  opts.container.innerHTML = ""
  opts.container.appendChild(display)

  if (opts.onDisplayResize) {
    displayCtl.onresize = (w: number, h: number) => {
      dbg("display resize ->", w, h)
      opts.onDisplayResize?.(w, h)
    }
  }

  // Input — mouse (always), keyboard (always), touch (if available).
  const mouse = new G.Mouse(display)
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state: unknown) =>
    client.sendMouseState(state)
  const keyboard = new G.Keyboard(document)
  keyboard.onkeydown = (key: number) => client.sendKeyEvent(1, key)
  keyboard.onkeyup = (key: number) => client.sendKeyEvent(0, key)
  // Plan 13.D.4 — touch. Library has Guacamole.Touch since 1.4. Wrap if
  // present; fall back silently if older library bundle lacks it.
  if (typeof G.Touch === "function") {
    const touch = new G.Touch(display)
    touch.onmousedown = touch.onmouseup = touch.onmousemove = (state: unknown) =>
      client.sendMouseState(state)
  }

  // Plan 13.D.3 — bandwidth-in metric. Chain tunnel.oninstruction: capture
  // the previous handler installed by Client, sum byte sizes of opcodes +
  // args, then delegate. Bytes counted are characters, which approximates
  // wire bytes (Guacamole encodes ASCII + length-prefixed UTF-16 mostly).
  let bytesInSinceLastTick = 0
  let bytesInTotal = 0
  const origOnInstruction = tunnel.oninstruction
  tunnel.oninstruction = (opcode, params) => {
    const size = opcode.length + params.reduce((s, p) => s + p.length, 0)
    bytesInSinceLastTick += size
    bytesInTotal += size
    origOnInstruction?.(opcode, params)
  }

  // Plan 13.D.1 — emit metrics every 1s. Only run if a callback is set so
  // we don't waste a timer for displays that don't show the gauges.
  let metricsTimer: number | null = null
  if (opts.onMetrics) {
    metricsTimer = window.setInterval(() => {
      const now = Date.now()
      const lastSyncAgeMs = now - lastSyncAt
      opts.onMetrics?.({
        lastSyncAgeMs,
        bytesPerSecIn: bytesInSinceLastTick, // ~1s window
        bytesIn: bytesInTotal,
      })
      bytesInSinceLastTick = 0
    }, 1000)
  }

  // Plan 13.C.1 — wrap client.connect() in try/catch. The library version
  // we ship throws synchronously on a few internal invariants (e.g.,
  // re-entrant connect). Without this the React effect crashes and the
  // state machine never sees an error.
  try {
    client.connect(
      `width=${opts.width}&height=${opts.height}&dpi=${opts.dpi ?? 96}`,
    )
  } catch (e) {
    if (metricsTimer != null) window.clearInterval(metricsTimer)
    const msg = (e as Error).message || String(e)
    dbg("client.connect threw:", msg)
    opts.onError?.({ message: `client.connect 异常: ${msg}` })
    throw e
  }

  return {
    client,
    disconnect() {
      dbg("disconnect")
      if (metricsTimer != null) window.clearInterval(metricsTimer)
      try {
        client.disconnect()
      } catch {
        /* */
      }
      try {
        tunnel.disconnect?.()
      } catch {
        /* */
      }
    },
    sendResize(w: number, h: number) {
      try {
        client.sendSize?.(w, h)
        displayCtl.resize(displayCtl.getDefaultLayer(), w, h)
      } catch {
        /* */
      }
    },
    sendCtrlAltDel() {
      // Press Ctrl + Alt + Del, then release in reverse order.
      const seq: Array<[number, number]> = [
        [1, KEYSYMS.Ctrl],
        [1, KEYSYMS.Alt],
        [1, KEYSYMS.Delete],
        [0, KEYSYMS.Delete],
        [0, KEYSYMS.Alt],
        [0, KEYSYMS.Ctrl],
      ]
      for (const [pressed, ks] of seq) client.sendKeyEvent(pressed, ks)
    },
    pushClipboard(text: string) {
      if (!text) return
      if (typeof client.createClipboardStream !== "function") return
      if (!G.StringWriter) return
      try {
        const stream = client.createClipboardStream("text/plain")
        if (!stream) return
        const writer = new G.StringWriter(stream)
        writer.sendText(text)
        writer.sendEnd()
        dbg("pushed clipboard", text.length, "chars")
      } catch (e) {
        dbg("pushClipboard failed", e)
      }
    },
  }
}
