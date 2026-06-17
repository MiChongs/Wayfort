"use client"

// RDPDisplay — Plan 15 top-level component, drop-in replacement for
// GuacamoleDisplay. Mounts a host div that the RDPClient takes over;
// renders the toolbar, loader overlay, recording status, and annotation
// toolbar above it.

import * as React from "react"
import { toast } from "@/components/ui/sonner"
import { useRDP } from "@/lib/hooks/use-rdp"
import { GuacLoader } from "@/components/guacamole/guac-loader"
import { RDPToolbar } from "./rdp-toolbar"
import { AnnotationToolbar, type AnnotationTool } from "./annotation-toolbar"
import { RecordingStatus } from "./recording-status"
import { SessionWatermark } from "@/components/watermark/session-watermark"

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

  // F11 → fullscreen toggle. Plan 16.C.3 adds Ctrl+Shift+ shortcut grid for
  // every other major feature so power users never need the mouse.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault()
        if (isFullscreen) rdp.exitFullscreen()
        else rdp.enterFullscreen()
        return
      }
      // Ctrl+Shift+<key> — namespaced to avoid clobbering remote shell
      // shortcuts (Ctrl+C copy etc. stay intact). We call the rdp facade
      // directly rather than going through the toast-wrapped React
      // callbacks; means no extra dependency churn here.
      if (!(e.ctrlKey && e.shiftKey)) return
      const k = e.key.toLowerCase()
      const dispatched = {
        "1": () => rdp.setViewportMode("fit"),
        "2": () => rdp.setViewportMode("fill"),
        "3": () => rdp.setViewportMode("actual"),
        "0": () => rdp.setViewportMode("fit"),
        r: () =>
          rdp.recording.state === "recording"
            ? void rdp.recordingStop()
            : void rdp.recordingStart(),
        s: () => void rdp.screenshotDownload(),
        a: () => rdp.toggleAnnotation(),
        m: () => rdp.toggleMinimap(),
        p: () => rdp.toggleStats(),
      } as Record<string, (() => void) | undefined>
      const fn = dispatched[k]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isFullscreen, rdp])

  // Plan 16.C.1 — sync the browser tab title with the connected node, so a
  // user with many open tabs can tell them apart at a glance.
  React.useEffect(() => {
    if (rdp.phase !== "connected" || !nodeName) return
    const prev = document.title
    document.title = `${nodeName} · ${protocol.toUpperCase()} · Wayfort`
    return () => {
      document.title = prev
    }
  }, [rdp.phase, nodeName, protocol])

  // Plan 16.C.2 — pinch-zoom (touch). Two simultaneous PointerEvents on the
  // host drive rdp.zoom(ratio). Single-finger / mouse pointer events fall
  // through to the Guac element unchanged.
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const pointers = new Map<number, { x: number; y: number }>()
    let lastDist = 0
    function dist() {
      const pts = [...pointers.values()]
      if (pts.length < 2) return 0
      const dx = pts[0].x - pts[1].x
      const dy = pts[0].y - pts[1].y
      return Math.hypot(dx, dy)
    }
    function onDown(e: PointerEvent) {
      if (e.pointerType !== "touch") return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) lastDist = dist()
    }
    function onMove(e: PointerEvent) {
      if (e.pointerType !== "touch") return
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        const d = dist()
        if (lastDist > 0 && d > 0) {
          const ratio = d / lastDist
          if (Math.abs(ratio - 1) > 0.02) {
            rdp.zoom(ratio)
            lastDist = d
          }
        }
      }
    }
    function onUp(e: PointerEvent) {
      pointers.delete(e.pointerId)
      lastDist = 0
    }
    host.addEventListener("pointerdown", onDown)
    host.addEventListener("pointermove", onMove)
    host.addEventListener("pointerup", onUp)
    host.addEventListener("pointercancel", onUp)
    return () => {
      host.removeEventListener("pointerdown", onDown)
      host.removeEventListener("pointermove", onMove)
      host.removeEventListener("pointerup", onUp)
      host.removeEventListener("pointercancel", onUp)
    }
  }, [rdp])

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
      <SessionWatermark
        targetRef={wrapperRef}
        sessionCtx={{
          asset: nodeName,
          host: nodeHost ? (nodePort ? `${nodeHost}:${nodePort}` : nodeHost) : undefined,
        }}
      />
      {/* The host div is what RDPClient mounts into. After Plan 16 it
          contains: (1) the Guacamole display wrapper (event-receiving,
          renders the real desktop + cursor), (2) the Pixi canvas above
          (transparent overlay for annotations). No cursor:none — the
          Guacamole cursor layer draws the remote pointer inside the
          desktop area; outside it we want the browser arrow back. */}
      <div
        ref={hostRef}
        className="absolute inset-0"
        style={{ touchAction: "none" }}
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
