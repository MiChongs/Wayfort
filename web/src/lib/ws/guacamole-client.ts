// Loader for guacamole-common-js — pulled from jsDelivr on demand. We avoid
// adding it to package.json because the npm release lags behind upstream and
// the UMD build is what wires cleanly into a browser canvas.

import { getAccessToken } from "@/lib/auth/tokens"

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://127.0.0.1:8080"
const SCRIPT_URL = "https://cdn.jsdelivr.net/npm/guacamole-common-js@1.6.0/dist/guacamole-common-min.js"

let scriptPromise: Promise<void> | null = null

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if ((window as unknown as { Guacamole?: unknown }).Guacamole) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script")
    s.src = SCRIPT_URL
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error("failed to load guacamole-common-js"))
    document.head.appendChild(s)
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
  onError?: (err: string) => void
}

export async function connectGuacamole(opts: GuacOpts) {
  await loadScript()
  const G = (window as unknown as { Guacamole: any }).Guacamole // eslint-disable-line @typescript-eslint/no-explicit-any
  const token = getAccessToken() ?? ""
  const url = `${WS_BASE}/api/v1/ws/${opts.protocol}/${opts.nodeId}?token=${token}&width=${opts.width}&height=${opts.height}&dpi=${opts.dpi ?? 96}`
  const tunnel = new G.WebSocketTunnel(url)
  const client = new G.Client(tunnel)
  client.onerror = (status: { message: string }) => opts.onError?.(status?.message || "guac error")
  client.onstatechange = (s: number) => opts.onStateChange?.(s)
  const display = client.getDisplay().getElement()
  opts.container.innerHTML = ""
  opts.container.appendChild(display)
  const mouse = new G.Mouse(display)
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state: unknown) => client.sendMouseState(state)
  const keyboard = new G.Keyboard(document)
  keyboard.onkeydown = (key: number) => client.sendKeyEvent(1, key)
  keyboard.onkeyup = (key: number) => client.sendKeyEvent(0, key)
  client.connect(`width=${opts.width}&height=${opts.height}&dpi=${opts.dpi ?? 96}`)
  return {
    disconnect() {
      try { client.disconnect() } catch { /* */ }
      try { tunnel.disconnect() } catch { /* */ }
    },
    sendResize(w: number, h: number) {
      client.getDisplay().resize(client.getDisplay().getDefaultLayer(), w, h)
    },
  }
}
