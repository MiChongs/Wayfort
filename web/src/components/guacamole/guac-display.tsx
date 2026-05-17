"use client"

import * as React from "react"
import { toast } from "sonner"
import { useGuacamole } from "@/lib/hooks/use-guacamole"
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
  const guac = useGuacamole({
    protocol,
    nodeId,
    containerRef,
    fullscreenTargetRef: wrapperRef,
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

  const showLoader =
    guac.phase !== "connected" && guac.phase !== "disconnected"

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
        onSendCtrlAltDel={guac.sendCtrlAltDel}
        onReconnect={guac.reconnect}
        onDisconnect={guac.disconnect}
        onToggleFullscreen={() => {
          if (isFullscreen) guac.exitFullscreen()
          else guac.enterFullscreen()
        }}
        backHref={backHref}
      />

      <div
        ref={containerRef}
        tabIndex={0}
        className="h-full w-full flex items-center justify-center focus:outline-none cursor-default"
      />

      {showLoader && (
        <GuacLoader
          phase={guac.phase}
          elapsedMs={guac.elapsedMs}
          errorTitle={guac.error?.title}
          errorHint={guac.error?.hint}
          errorCode={guac.error?.code}
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
