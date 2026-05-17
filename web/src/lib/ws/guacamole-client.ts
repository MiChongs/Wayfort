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

import { getAccessToken } from "@/lib/auth/tokens"

const WS_BASE =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"

// Bumped path includes ?v= to bust stale browser cache when we eventually
// upgrade the vendored library.
const VENDOR_URL = "/vendor/guacamole-common.min.js?v=1.5.0"

type GuacNS = {
  Client: new (tunnel: unknown) => GuacClientLike
  WebSocketTunnel: new (url: string) => unknown
  Mouse: new (el: HTMLElement) => GuacMouseLike
  Keyboard: new (target: Document | HTMLElement) => GuacKeyboardLike
  Status: {
    Code: Record<string, number>
  }
}

interface GuacClientLike {
  onerror?: (status: { code?: number; message?: string }) => void
  onstatechange?: (state: number) => void
  getDisplay(): {
    getElement(): HTMLElement
    resize(layer: unknown, w: number, h: number): void
    getDefaultLayer(): unknown
    onresize?: (w: number, h: number) => void
  }
  sendMouseState(state: unknown): void
  sendKeyEvent(pressed: number, keysym: number): void
  sendSize(w: number, h: number): void
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

export type GuacOpts = {
  protocol: "rdp" | "vnc"
  nodeId: number
  width: number
  height: number
  dpi?: number
  container: HTMLElement
  onStateChange?: (state: number) => void
  onError?: (err: { code?: number; message: string }) => void
  onDisplayResize?: (w: number, h: number) => void
}

export interface GuacHandle {
  disconnect(): void
  sendResize(w: number, h: number): void
  sendCtrlAltDel(): void
  client: GuacClientLike
}

const KEYSYMS = {
  Ctrl: 0xffe3,
  Alt: 0xffe9,
  Delete: 0xffff,
}

export async function connectGuacamole(opts: GuacOpts): Promise<GuacHandle> {
  const G = await ensureGuacamoleScript()
  const token = getAccessToken() ?? ""
  const url = `${WS_BASE}/api/v1/ws/${opts.protocol}/${opts.nodeId}?token=${token}&width=${opts.width}&height=${opts.height}&dpi=${opts.dpi ?? 96}`
  const tunnel = new G.WebSocketTunnel(url)
  const client = new G.Client(tunnel)
  client.onerror = (status) =>
    opts.onError?.({
      code: status?.code,
      message: status?.message || `guac error (code=${status?.code ?? "?"})`,
    })
  client.onstatechange = (s) => opts.onStateChange?.(s)
  const displayCtl = client.getDisplay()
  const display = displayCtl.getElement()
  opts.container.innerHTML = ""
  opts.container.appendChild(display)
  if (opts.onDisplayResize && displayCtl.onresize === undefined) {
    // Some library versions expose onresize on the display; if not, we just
    // skip — sendResize is the authoritative path.
  }
  const mouse = new G.Mouse(display)
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state: unknown) =>
    client.sendMouseState(state)
  const keyboard = new G.Keyboard(document)
  keyboard.onkeydown = (key: number) => client.sendKeyEvent(1, key)
  keyboard.onkeyup = (key: number) => client.sendKeyEvent(0, key)
  client.connect(
    `width=${opts.width}&height=${opts.height}&dpi=${opts.dpi ?? 96}`,
  )
  return {
    client,
    disconnect() {
      try {
        client.disconnect()
      } catch {
        /* */
      }
      try {
        ;(tunnel as { disconnect?: () => void }).disconnect?.()
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
  }
}
