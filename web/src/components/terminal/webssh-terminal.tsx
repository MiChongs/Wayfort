"use client"

import * as React from "react"
import { toast } from "sonner"
import { WebSSHConnection } from "@/lib/ws/webssh-client"
import "@xterm/xterm/css/xterm.css"

type Props = {
  protocol: "ssh" | "telnet" | "dbcli"
  nodeId: number
  fontSize?: number
}

/**
 * WebSSH terminal: lazy-loads xterm, wires resize observers and ping/pong,
 * forwards keystrokes to the backend WS, paints output bytes back into the
 * terminal. xterm is imported dynamically so we never SSR it.
 */
export function WebSSHTerminal({ protocol, nodeId, fontSize = 13 }: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<unknown>(null)
  const fitRef = React.useRef<unknown>(null)
  const connRef = React.useRef<WebSSHConnection | null>(null)
  const [status, setStatus] = React.useState<"connecting" | "open" | "closed">("connecting")

  React.useEffect(() => {
    let disposed = false
    let resizeObserver: ResizeObserver | undefined

    ;(async () => {
      const { Terminal } = await import("@xterm/xterm")
      const { FitAddon } = await import("@xterm/addon-fit")
      const { WebLinksAddon } = await import("@xterm/addon-web-links")
      if (disposed) return

      const term = new Terminal({
        fontSize,
        cursorBlink: true,
        convertEol: true,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        theme: {
          background: "#09090b",
          foreground: "#e4e4e7",
        },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      const el = containerRef.current!
      term.open(el)
      try { fit.fit() } catch { /* noop */ }
      termRef.current = term
      fitRef.current = fit

      const path = protocol === "ssh"
        ? `/ws/ssh/${nodeId}`
        : protocol === "telnet"
          ? `/ws/telnet/${nodeId}`
          : `/ws/dbcli/${nodeId}`

      const conn = new WebSSHConnection(path, {
        onReady: () => setStatus("open"),
        onOutput: (bytes) => term.write(bytes),
        onError: (m) => toast.error("会话错误", { description: m }),
        onClose: (m) => {
          setStatus("closed")
          term.writeln(`\r\n\x1b[33m[connection closed: ${m}]\x1b[0m`)
        },
      })
      conn.open({ cols: term.cols, rows: term.rows })
      connRef.current = conn

      term.onData((d) => conn.sendInput(d))
      term.onResize(({ cols, rows }) => conn.resize(cols, rows))

      resizeObserver = new ResizeObserver(() => {
        try { fit.fit() } catch { /* noop */ }
      })
      resizeObserver.observe(el)
    })().catch((e) => toast.error("终端加载失败", { description: String(e) }))

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      connRef.current?.close()
      const term = termRef.current as { dispose?: () => void } | null
      term?.dispose?.()
    }
  }, [protocol, nodeId, fontSize])

  return (
    <div className="relative h-full w-full bg-zinc-950 overflow-hidden">
      {status === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
          正在连接…
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
