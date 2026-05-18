"use client"

// RDPDisplay — Plan 15 top-level component, drop-in replacement for
// GuacamoleDisplay. Mounts a host div that the RDPClient takes over;
// renders the toolbar, loader overlay, recording status, and annotation
// toolbar above it.

import * as React from "react"
import { toast } from "sonner"
import { useRDP } from "@/lib/hooks/use-rdp"
import { GuacLoader } from "@/components/guacamole/guac-loader"
import { RDPToolbar } from "./rdp-toolbar"
import { AnnotationToolbar, type AnnotationTool } from "./annotation-toolbar"
import { RecordingStatus } from "./recording-status"

export interface RDPDisplayProps {
  protocol: "rdp" | "vnc"
  nodeId: number
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  backHref?: string
}

export function RDPDisplay({
  protocol,
  nodeId,
  nodeName,
  nodeHost,
  nodePort,
  backHref,
}: RDPDisplayProps) {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)
  const hostRef = React.useRef<HTMLDivElement | null>(null)

  // Remote → local clipboard sync (Plan 13). Same handler shape.
  const handleRemoteClipboard = React.useCallback((text: string) => {
    if (!text || typeof navigator === "undefined") return
    navigator.clipboard?.writeText(text).catch(() => {})
  }, [])

  const rdp = useRDP({
    protocol,
    nodeId,
    nodeName,
    hostRef,
    fullscreenTargetRef: wrapperRef,
    onRemoteClipboard: handleRemoteClipboard,
  })

  const [isFullscreen, setIsFullscreen] = React.useState(false)
  React.useEffect(() => {
    const onFs = () => setIsFullscreen(document.fullscreenElement === wrapperRef.current)
    document.addEventListener("fullscreenchange", onFs)
    return () => document.removeEventListener("fullscreenchange", onFs)
  }, [])

  // Surface errors as toast (Plan 12 parity).
  const lastErrorTitleRef = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    if (rdp.phase === "error" && rdp.error?.title !== lastErrorTitleRef.current) {
      lastErrorTitleRef.current = rdp.error?.title
      toast.error(rdp.error?.title ?? "远程桌面错误", { description: rdp.error?.hint })
    }
    if (rdp.phase !== "error") lastErrorTitleRef.current = undefined
  }, [rdp.phase, rdp.error?.title, rdp.error?.hint])

  // Local annotation tool state (the toolbar UI; plugin state lives in hook).
  const [annoTool, setAnnoTool] = React.useState<AnnotationTool>("pen")
  const [annoColor, setAnnoColor] = React.useState<number>(0xef4444)

  // Browser → remote clipboard via wrapper paste event.
  React.useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const text = e.clipboardData?.getData("text/plain")
      if (text) rdp.pushClipboard(text)
    }
    const w = wrapperRef.current
    w?.addEventListener("paste", onPaste)
    return () => w?.removeEventListener("paste", onPaste)
  }, [rdp])

  // F11 → fullscreen toggle.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault()
        if (isFullscreen) rdp.exitFullscreen()
        else rdp.enterFullscreen()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isFullscreen, rdp])

  // Recording stop with toast.
  const onRecordingStart = React.useCallback(async () => {
    try {
      await rdp.recordingStart()
      toast.success("开始录制", { description: "录制画面到本地 WebM 文件" })
    } catch (e) {
      toast.error("录制启动失败", { description: (e as Error).message })
    }
  }, [rdp])
  const onRecordingStop = React.useCallback(async () => {
    try {
      await rdp.recordingStop()
      toast.success("录制已停止", { description: "WebM 文件已下载" })
    } catch (e) {
      toast.error("录制停止失败", { description: (e as Error).message })
    }
  }, [rdp])

  const onScreenshotDownload = React.useCallback(async () => {
    try {
      await rdp.screenshotDownload()
      toast.success("截图已下载")
    } catch (e) {
      toast.error("截图失败", { description: (e as Error).message })
    }
  }, [rdp])
  const onScreenshotCopy = React.useCallback(async () => {
    try {
      await rdp.screenshotCopy()
      toast.success("截图已复制到剪贴板")
    } catch (e) {
      toast.error("复制失败", { description: (e as Error).message })
    }
  }, [rdp])

  const showLoader = rdp.phase !== "connected" && rdp.phase !== "disconnected"

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full bg-black overflow-hidden focus:outline-none"
      tabIndex={0}
    >
      {/* The host div is what RDPClient mounts the Pixi canvas + hidden Guac
          element into. It must be position: relative for children to anchor. */}
      <div
        ref={hostRef}
        className="absolute inset-0"
        // Pixi canvas inside is pointer-events:none; the hidden Guac wrapper
        // is pointer-events:auto. cursor: none everywhere so the remote
        // cursor (rendered into Guac's canvas) shows through alone.
        style={{ cursor: "none" }}
      />

      <RDPToolbar
        protocol={protocol}
        nodeName={nodeName}
        nodeHost={nodeHost}
        nodePort={nodePort}
        phase={rdp.phase}
        reconnectAttempts={rdp.reconnectAttempts}
        isFullscreen={isFullscreen}
        quality={rdp.quality}
        metrics={rdp.metrics}
        viewport={rdp.viewport}
        recording={rdp.recording}
        annotationOn={rdp.annotationOn}
        statsOn={rdp.statsOn}
        minimapOn={rdp.minimapOn}
        backHref={backHref}
        onSendCtrlAltDel={rdp.sendCtrlAltDel}
        onReconnect={rdp.reconnect}
        onDisconnect={rdp.disconnect}
        onToggleFullscreen={() => {
          if (isFullscreen) rdp.exitFullscreen()
          else rdp.enterFullscreen()
        }}
        onQualityChange={rdp.setQuality}
        onZoom={rdp.zoom}
        onSetViewportMode={rdp.setViewportMode}
        onScreenshotDownload={onScreenshotDownload}
        onScreenshotCopy={onScreenshotCopy}
        onRecordingStart={onRecordingStart}
        onRecordingStop={onRecordingStop}
        onToggleAnnotation={() => rdp.toggleAnnotation()}
        onToggleStats={() => rdp.toggleStats()}
        onToggleMinimap={() => rdp.toggleMinimap()}
      />

      <AnnotationToolbar
        visible={rdp.annotationOn}
        tool={annoTool}
        color={annoColor}
        onToolChange={(t) => {
          setAnnoTool(t)
          rdp.setAnnotationTool(t)
        }}
        onColorChange={(c) => {
          setAnnoColor(c)
          rdp.setAnnotationColor(c)
        }}
        onUndo={rdp.annotationUndo}
        onRedo={rdp.annotationRedo}
        onClear={rdp.annotationClear}
        onClose={() => rdp.toggleAnnotation(false)}
      />

      <RecordingStatus event={rdp.recording} onStop={onRecordingStop} />

      {showLoader && (
        <GuacLoader
          phase={rdp.phase}
          elapsedMs={rdp.elapsedMs}
          errorTitle={rdp.error?.title}
          errorHint={rdp.error?.hint}
          errorCode={rdp.error?.code}
          errorAction={rdp.error?.action}
          nodeName={nodeName}
          onRetry={rdp.reconnect}
        />
      )}

      {rdp.phase === "disconnected" && !rdp.error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/90 backdrop-blur-sm">
          <div className="text-center space-y-3">
            <div className="text-sm text-zinc-300">已断开连接</div>
            <button
              type="button"
              onClick={rdp.reconnect}
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
