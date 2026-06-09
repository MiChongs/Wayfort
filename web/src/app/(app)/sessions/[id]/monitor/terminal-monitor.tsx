"use client"

import * as React from "react"
import { sessionService } from "@/lib/api/services"
import { WebSSHConnection } from "@/lib/ws/webssh-client"
import { resolveTerminalTheme } from "@/components/terminal/terminal-themes"

// TerminalMonitor renders a strictly read-only xterm fed by the observe WS. It
// follows the watched terminal's size (server resize frames) and never attaches
// input — no onData, no keyboard. The hub replays a scrollback baseline on
// connect so the viewer is fast-forwarded to the current screen.
export function TerminalMonitor({
  sessionId,
  onLatency,
  onClosed,
}: {
  sessionId: string
  onLatency?: (ms: number) => void
  onClosed?: (reason: string) => void
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    let disposed = false
    let conn: WebSSHConnection | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null

    ;(async () => {
      const { Terminal } = await import("@xterm/xterm")
      const { FitAddon } = await import("@xterm/addon-fit")
      if (disposed || !hostRef.current) return

      const sysIsDark =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-color-scheme: dark)").matches
      term = new Terminal({
        fontSize: 14,
        fontFamily:
          'var(--font-mono), "JetBrains Mono", Menlo, Consolas, monospace',
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        allowProposedApi: true,
        theme: resolveTerminalTheme("system", !!sysIsDark).colors,
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(hostRef.current)
      try {
        fit.fit()
      } catch {
        /* host not measured yet */
      }

      conn = new WebSSHConnection(`/ws/observe/terminal/${sessionId}`, {
        onOutput: (bytes) => term?.write(bytes),
        onResize: (cols, rows) => {
          // Follow the watched session's geometry exactly.
          try {
            term?.resize(cols, rows)
          } catch {
            /* ignore bad dims */
          }
        },
        onLatency: (ms) => onLatency?.(ms),
        onClose: (reason) => onClosed?.(reason || "会话已结束"),
        onError: (msg) => onClosed?.(msg),
      })
      conn.open()
    })()

    return () => {
      disposed = true
      conn?.close()
      term?.dispose?.()
    }
  }, [sessionId, onLatency, onClosed])

  return (
    <div className="h-full w-full overflow-auto bg-black p-2">
      <div ref={hostRef} className="h-full w-full" />
    </div>
  )
}
