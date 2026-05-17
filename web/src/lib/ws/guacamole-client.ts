"use client"

// Guacamole client adapter. Earlier attempts:
//   1. CDN <script> at unpkg/jsDelivr → 404 because version 1.6.0 doesn't
//      exist and CDN may be blocked in restricted networks.
//   2. Dynamic `import("guacamole-common-js")` → Turbopack/Webpack on Next 16
//      emitted only an SSR chunk for the dynamic-imported package and no
//      static/chunks counterpart, so the browser hit "Cannot find module".
//
// Final approach: explicit `"use client"` at the top of THIS file so the
// bundler knows everything here is browser-side, then a normal top-level
// import of guacamole-common-js. Turbopack reliably puts it in the client
// chunk for `guac-display.tsx`, which is the only consumer.
// The ~500 KB cost only lands when a user actually navigates to /rdp or /vnc.

import GuacamoleNS from "guacamole-common-js"
import { getAccessToken } from "@/lib/auth/tokens"

const WS_BASE =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"

// The package's typing is `unknown` (we added a minimal d.ts). Coerce to a
// permissive shape so call sites have ergonomic types.
type GuacNS = {
  Client: new (tunnel: unknown) => GuacClientLike
  WebSocketTunnel: new (url: string) => unknown
  Mouse: new (el: HTMLElement) => GuacMouseLike
  Keyboard: new (target: Document | HTMLElement) => GuacKeyboardLike
}

interface GuacClientLike {
  onerror?: (status: { message?: string }) => void
  onstatechange?: (state: number) => void
  getDisplay(): {
    getElement(): HTMLElement
    resize(layer: unknown, w: number, h: number): void
    getDefaultLayer(): unknown
  }
  sendMouseState(state: unknown): void
  sendKeyEvent(pressed: number, keysym: number): void
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

const G = GuacamoleNS as unknown as GuacNS

// Make the loaded namespace available on `window.Guacamole` for any external
// snippet that still expects the classic UMD-style global (e.g. dev tools
// poking, or session-replay code reusing the loaded module).
if (typeof window !== "undefined") {
  ;(window as unknown as { Guacamole?: GuacNS }).Guacamole = G
}

export type GuacOpts = {
  protocol: "rdp" | "vnc"
  nodeId: number
  width: number
  height: number
  dpi?: number
  container: HTMLElement
  onStateChange?: (state: number) => void
  onError?: (err: string) => void
}

export async function connectGuacamole(opts: GuacOpts) {
  if (typeof window === "undefined") {
    throw new Error("guacamole only runs in the browser")
  }
  if (!G || typeof G.Client !== "function") {
    throw new Error("guacamole-common-js failed to load (Client missing)")
  }
  const token = getAccessToken() ?? ""
  const url = `${WS_BASE}/api/v1/ws/${opts.protocol}/${opts.nodeId}?token=${token}&width=${opts.width}&height=${opts.height}&dpi=${opts.dpi ?? 96}`
  const tunnel = new G.WebSocketTunnel(url)
  const client = new G.Client(tunnel)
  client.onerror = (status) => opts.onError?.(status?.message || "guac error")
  client.onstatechange = (s) => opts.onStateChange?.(s)
  const display = client.getDisplay().getElement()
  opts.container.innerHTML = ""
  opts.container.appendChild(display)
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
      client.getDisplay().resize(client.getDisplay().getDefaultLayer(), w, h)
    },
  }
}
