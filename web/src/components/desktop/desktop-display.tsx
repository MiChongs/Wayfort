"use client"

// DesktopDisplay — Plan 17 M1 top-level React component. Mounts the
// OffscreenCanvas renderer, opens the WS data channel via FrameClient,
// attaches input handlers, and surfaces phase + errors with the existing
// GuacLoader overlay so users get consistent loading UX across stacks.
//
// This component DOES NOT touch guacd / guacamole-common-js. It's the
// browser counterpart to the worker-based backend.

import * as React from "react"
import { toast } from "sonner"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { GuacLoader } from "@/components/guacamole/guac-loader"
import { describeGuacError, type GuacPhase } from "@/components/guacamole/guac-errors"
import { desktopControl } from "@/lib/desktop/control-client"
import { createRenderer, type CanvasRendererHandle } from "@/lib/desktop/canvas-renderer"
import { FrameClient } from "@/lib/desktop/frame-client"
import { attachInputs } from "@/lib/desktop/input"
import { base64ToBytes, type Phase, type SessionStatus } from "@/lib/desktop/types"

export interface DesktopDisplayProps {
  nodeId: number
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  backHref?: string
  // Default freerdp — server's desktop.default_backend config is the
  // authoritative source; this prop only matters when a caller wants to
  // override (e.g. force "dummy" for testing without libfreerdp).
  backend?: "freerdp" | "dummy"
}

export function DesktopDisplay({
  nodeId,
  nodeName,
  nodeHost,
  nodePort,
  backHref,
  backend = "freerdp",
}: DesktopDisplayProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const rendererRef = React.useRef<CanvasRendererHandle | null>(null)
  const clientRef = React.useRef<FrameClient | null>(null)
  const detachInputsRef = React.useRef<(() => void) | null>(null)
  const [phase, setPhase] = React.useState<GuacPhase>("loading-script")
  const [error, setError] = React.useState<{ title: string; hint?: string; code?: number } | undefined>()
  const [startedAt] = React.useState(() => Date.now())
  const [, force] = React.useState(0)

  // Tick once per second so GuacLoader.elapsedMs updates the "已用时 X.Xs"
  // counter while pre-CONNECTED. Cheap.
  React.useEffect(() => {
    if (phase === "connected" || phase === "error") return
    const t = window.setInterval(() => force((v) => v + 1), 250)
    return () => window.clearInterval(t)
  }, [phase])

  React.useEffect(() => {
    let cancelled = false
    let sessionId = ""

    ;(async () => {
      try {
        const start = await desktopControl.startSession({
          node_id: nodeId,
          width: 1280,
          height: 720,
          dpi: 96,
          quality: "auto",
          backend,
        })
        if (cancelled) return
        sessionId = start.session_id

        const renderer = createRenderer(start.remote_width || 1280, start.remote_height || 720)
        rendererRef.current = renderer
        const host = hostRef.current
        if (!host) return
        host.innerHTML = ""
        host.appendChild(renderer.canvas)

        // Worker may grow the canvas when the remote desktop reports a
        // different size; mirror to the React side so the loader / sizing
        // computations stay accurate.
        renderer.onResize((w, h) => {
          renderer.canvas.width = w
          renderer.canvas.height = h
        })
        // Cursor: apply remote PNG as the canvas's CSS cursor.
        renderer.onCursor(({ x, y, png }) => {
          renderer.canvas.style.cursor = `url(data:image/png;base64,${png}) ${x} ${y}, default`
        })

        const client = new FrameClient({
          sessionId,
          renderWorker: renderer.worker,
          onStatus: (s: SessionStatus) => {
            const next = phaseFromStatus(s.phase)
            setPhase(next)
            if (next === "error") {
              const friendly = describeGuacError(s.code, s.message)
              setError({ title: friendly.title, hint: friendly.hint, code: s.code })
              toast.error(friendly.title, { description: friendly.hint })
            }
          },
          onError: (msg) => {
            setPhase("error")
            setError({ title: "传输错误", hint: msg })
          },
          onClipboard: (data) => {
            // Plan 17 M2 — remote CLIPRDR text → browser clipboard. The
            // worker forwards in MS UTF-16LE per MS-RDPECLIP §2.2.5.2.1;
            // decode here so navigator.clipboard receives a Unicode
            // string. Other MIME types (image, file-list) are recognised
            // but plumbed in M2.x.
            if (data.mime.startsWith("text/plain;charset=utf-16le")) {
              try {
                const bytes = base64ToBytes(data.payload)
                // Strip trailing null terminator(s) before decoding.
                let end = bytes.length
                while (end >= 2 && bytes[end - 1] === 0 && bytes[end - 2] === 0) end -= 2
                const text = new TextDecoder("utf-16le").decode(bytes.subarray(0, end))
                navigator.clipboard?.writeText(text).catch(() => {})
              } catch {
                /* malformed payload, ignore */
              }
            }
          },
        })
        client.connect()
        clientRef.current = client

        // Plan 17 M2 — bridge browser-side copy/paste to CLIPRDR.
        // On paste in the host area: forward the clipboard text to the
        // worker as `text/plain` so it can send a FORMAT_LIST + reply to
        // the server's FormatDataRequest.
        const onPaste = (e: ClipboardEvent) => {
          const text = e.clipboardData?.getData("text/plain")
          if (text) {
            client.send({
              clipboard: {
                mime: "text/plain",
                payload: btoa(unescape(encodeURIComponent(text))),
              },
            })
          }
        }
        host.addEventListener("paste", onPaste)

        detachInputsRef.current = attachInputs({
          host,
          send: (msg) => client.send(msg),
          getScale: () => {
            const c = renderer.canvas
            const rect = host.getBoundingClientRect()
            const sx = c.width > 0 ? rect.width / c.width : 1
            const sy = c.height > 0 ? rect.height / c.height : 1
            // We send remote pixels; toRemote divides by host/canvas ratio.
            // Returning the host/canvas ratio means dividing by it inverts.
            return { x: sx, y: sy }
          },
        })
      } catch (e) {
        if (cancelled) return
        setPhase("error")
        setError({ title: "无法建立桌面会话", hint: (e as Error).message })
      }
    })()

    return () => {
      cancelled = true
      detachInputsRef.current?.()
      detachInputsRef.current = null
      clientRef.current?.close()
      clientRef.current = null
      rendererRef.current?.destroy()
      rendererRef.current = null
      if (sessionId) {
        // Fire-and-forget — gateway also cleans up when WS closes.
        desktopControl.endSession(sessionId).catch(() => {})
      }
    }
  }, [nodeId, backend])

  const showLoader = phase !== "connected"

  return (
    <div className="relative h-full w-full bg-black overflow-hidden">
      <div className="absolute top-0 left-0 right-0 z-20 px-3 py-2 flex items-center gap-2 bg-background/80 backdrop-blur border-b border-border/60">
        {backHref && (
          <Button asChild variant="ghost" size="icon" className="h-7 w-7">
            <Link href={backHref as Parameters<typeof Link>[0]["href"]}>
              <ArrowLeft className="w-3.5 h-3.5" />
            </Link>
          </Button>
        )}
        <span className="text-sm font-medium truncate">{nodeName || `node #${nodeId}`}</span>
        <Badge variant="outline" className="text-[10px] h-4 px-1.5 uppercase">
          desktop · v2
        </Badge>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
          {backend}
        </Badge>
        {nodeHost && (
          <span className="text-[11px] font-mono text-muted-foreground truncate">
            {nodeHost}:{nodePort}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">phase: {phase}</span>
      </div>

      <div
        ref={hostRef}
        className="absolute inset-0 mt-10 flex items-center justify-center"
        tabIndex={0}
      />

      {showLoader && (
        <GuacLoader
          phase={phase}
          elapsedMs={Date.now() - startedAt}
          errorTitle={error?.title}
          errorHint={error?.hint}
          errorCode={error?.code}
          nodeName={nodeName}
          onRetry={() => window.location.reload()}
        />
      )}
    </div>
  )
}

function phaseFromStatus(p: Phase): GuacPhase {
  switch (p) {
    case "CONNECTING":   return "connecting"
    case "HANDSHAKE":    return "handshake"
    case "CONNECTED":    return "connected"
    case "RECONNECTING": return "connecting"
    case "CLOSED":       return "disconnected"
    case "ERROR":        return "error"
  }
}
