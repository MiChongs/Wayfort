// Guacamole client adapter. We bundle guacamole-common-js via npm (rather
// than the previous CDN script tag that 404'd because version 1.6.0 doesn't
// exist on jsDelivr — the highest published is 1.5.0). Dynamic import keeps
// the ~500 KB library out of the main bundle and only loads it when a user
// actually opens an RDP / VNC node.

import { getAccessToken } from "@/lib/auth/tokens"

const WS_BASE =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"

// The package's ESM build exports `Guacamole` as default. We don't know
// every method we'll call on it at TS compile time, so use a permissive
// shape and rely on the runtime.
type GuacamoleNS = Record<string, unknown> & {
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

let nsPromise: Promise<GuacamoleNS> | null = null

async function loadGuacamole(): Promise<GuacamoleNS> {
  if (typeof window === "undefined") {
    throw new Error("guacamole only runs in the browser")
  }
  // Reuse the window global if some other module already set it (e.g. an
  // older script tag in the page).
  const w = window as unknown as { Guacamole?: GuacamoleNS }
  if (w.Guacamole) return w.Guacamole
  if (!nsPromise) {
    nsPromise = (async () => {
      try {
        // Dynamic ESM import — Webpack/Turbopack split into its own chunk.
        const mod = (await import("guacamole-common-js")) as unknown as {
          default: GuacamoleNS
        }
        const G = mod.default
        // Stash on window for any consumer that still expects the global.
        w.Guacamole = G
        return G
      } catch (e: unknown) {
        nsPromise = null
        throw new Error(
          `failed to load guacamole-common-js: ${(e as Error).message}`,
        )
      }
    })()
  }
  return nsPromise
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
  const G = await loadGuacamole()
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
