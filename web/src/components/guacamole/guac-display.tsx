"use client"

import * as React from "react"
import { toast } from "@/components/ui/sonner"
import { useGuacamole } from "@/lib/hooks/use-guacamole"
import type { GuacQuality } from "@/lib/ws/guacamole-client"
import { GuacLoader } from "./guac-loader"
import { GuacToolbar } from "./guac-toolbar"

export interface GuacamoleDisplayProps {
  protocol: "rdp" | "vnc"
  nodeId: number
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  backHref?: string
}

export function GuacamoleDisplay({
  protocol,
  nodeId,
  nodeName,
  nodeHost,
  nodePort,
  backHref,
}: GuacamoleDisplayProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)

  // Plan 13.D.6 — when guacd pushes clipboard data, write it to the
  // browser's clipboard so Cmd+V in any other tab pastes the remote text.
  // navigator.clipboard.writeText needs the document to be focused; we
  // silently swallow PermissionDenied rather than nag the user.
  const handleRemoteClipboard = React.useCallback((text: string) => {
    if (!text || typeof navigator === "undefined") return
    navigator.clipboard?.writeText(text).catch(() => {
      /* user hasn't granted clipboard-write yet, ignore */
    })
  }, [])

  const guac = useGuacamole({
    protocol,
    nodeId,
    containerRef,
    fullscreenTargetRef: wrapperRef,
    onRemoteClipboard: handleRemoteClipboard,
  })

  const [isFullscreen, setIsFullscreen] = React.useState(false)
  React.useEffect(() => {
    function onFs() {
      setIsFullscreen(document.fullscreenElement === wrapperRef.current)
    }
    document.addEventListener("fullscreenchange", onFs)
    return () => document.removeEventListener("fullscreenchange", onFs)
  }, [])

  // Surface unrecoverable errors as toast too — easier to see if the user
  // already dismissed the overlay or it raced with a state change.
  const lastErrorTitleRef = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (guac.phase === "error" && guac.error?.title !== lastErrorTitleRef.current) {
      lastErrorTitleRef.current = guac.error?.title
      toast.error(guac.error?.title ?? "远程桌面错误", {
        description: guac.error?.hint,
      })
    }
    if (guac.phase !== "error") lastErrorTitleRef.current = undefined
  }, [guac.phase, guac.error?.title, guac.error?.hint])

  // Focus the container on mount so keyboard events land on guacd. We use
  // tabIndex={0} below; clicking the container also focuses it.
  React.useEffect(() => {
    if (guac.phase === "connected") {
      containerRef.current?.focus()
    }
  }, [guac.phase])

  // F11 → toggle fullscreen.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault()
        if (isFullscreen) guac.exitFullscreen()
        else guac.enterFullscreen()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isFullscreen, guac])

  // Plan 13.D.6 — browser → remote clipboard sync. We listen on the
  // wrapper (RDP canvas isn't a textarea so the native paste target is the
  // window). On paste, read the clipboard text and push to the remote.
  // The Clipboard API needs the document to be focused; this happens
  // automatically when the user interacts with the canvas.
  React.useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const text = e.clipboardData?.getData("text/plain")
      if (text) {
        guac.pushClipboard(text)
      }
    }
    function onCopy() {
      // Browser → remote copy isn't typically meaningful (the canvas has
      // no selectable content) but we still forward in case a future UI
      // overlay puts text on the page.
      navigator.clipboard?.readText().then((text) => {
        if (text) guac.pushClipboard(text)
      }).catch(() => {})
    }
    const wrap = wrapperRef.current
    wrap?.addEventListener("paste", onPaste)
    wrap?.addEventListener("copy", onCopy)
    return () => {
      wrap?.removeEventListener("paste", onPaste)
      wrap?.removeEventListener("copy", onCopy)
    }
  }, [guac])

  const showLoader =
    guac.phase !== "connected" && guac.phase !== "disconnected"

  const onQualityChange = React.useCallback(
    (q: GuacQuality) => {
      guac.setQuality(q)
    },
    [guac],
  )

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full bg-black overflow-hidden focus:outline-none"
    >
      <GuacToolbar
        protocol={protocol}
        nodeName={nodeName}
        nodeHost={nodeHost}
        nodePort={nodePort}
        phase={guac.phase}
        reconnectAttempts={guac.reconnectAttempts}
        isFullscreen={isFullscreen}
        quality={guac.quality}
        metrics={guac.metrics}
        onSendCtrlAltDel={guac.sendCtrlAltDel}
        onReconnect={guac.reconnect}
        onDisconnect={guac.disconnect}
        onToggleFullscreen={() => {
          if (isFullscreen) guac.exitFullscreen()
          else guac.enterFullscreen()
        }}
        onQualityChange={onQualityChange}
        backHref={backHref}
      />

      <div
        ref={containerRef}
        tabIndex={0}
        // Plan 13.D.5 — hide the browser cursor over the canvas so users
        // see only the remote desktop cursor that guacd renders inside the
        // canvas. cursor:none works in all evergreen browsers.
        className="h-full w-full flex items-center justify-center focus:outline-none cursor-none"
      />

      {showLoader && (
        <GuacLoader
          phase={guac.phase}
          elapsedMs={guac.elapsedMs}
          errorTitle={guac.error?.title}
          errorHint={guac.error?.hint}
          errorCode={guac.error?.code}
          errorAction={guac.error?.action}
          nodeName={nodeName}
          onRetry={guac.reconnect}
        />
      )}

      {guac.phase === "disconnected" && !guac.error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/90 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <div className="text-sm text-zinc-300">已断开连接</div>
            <button
              type="button"
              onClick={guac.reconnect}
              className="text-xs px-3 h-8 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            >
              重新连接
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
