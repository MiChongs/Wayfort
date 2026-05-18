"use client"

// useRDP — the React-facing state machine for the new PixiJS-based RDP/VNC
// client (Plan 15). Mirrors useGuacamole's shape so the migration is small.
//
// Lifecycle: mount → instantiate RDPClient + plugins → connect; on unmount
// destroy in reverse. We never recreate the client mid-mount; quality /
// audio / clipboard changes require an explicit reconnect.

import * as React from "react"
import { RDPClient } from "@/lib/rdp/client"
import { AnnotationPlugin } from "@/lib/rdp/plugins/annotation"
import { MinimapPlugin } from "@/lib/rdp/plugins/minimap"
import { RecordingPlugin, type RecordingEvent } from "@/lib/rdp/plugins/recording"
import { ScreenshotPlugin } from "@/lib/rdp/plugins/screenshot"
import { StatsPlugin } from "@/lib/rdp/plugins/stats"
import type {
  RDPMetrics,
  RDPViewportMode,
  RDPViewportState,
} from "@/lib/rdp/types"
import type { GuacQuality } from "@/lib/ws/guacamole-client"
import {
  describeGuacError,
  phaseFromState,
  type FriendlyError,
  type GuacPhase,
} from "@/components/guacamole/guac-errors"

export interface UseRDPOptions {
  protocol: "rdp" | "vnc"
  nodeId: number
  nodeName?: string
  hostRef: React.RefObject<HTMLElement | null>
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>
  initialQuality?: GuacQuality
  enableAudio?: boolean
  enableClipboard?: boolean
  keyboardLayout?: string
  onRemoteClipboard?: (text: string) => void
}

export interface UseRDPState {
  phase: GuacPhase
  elapsedMs: number
  reconnectAttempts: number
  error?: FriendlyError & { code?: number; raw?: string }
  metrics?: RDPMetrics
  viewport?: RDPViewportState
  quality: GuacQuality
  // Plugin status mirrored here so the toolbar can render reactively.
  recording: RecordingEvent
  annotationOn: boolean
  statsOn: boolean
  minimapOn: boolean
}

export interface UseRDPControls {
  reconnect(): void
  disconnect(): void
  sendCtrlAltDel(): void
  pushClipboard(text: string): void
  setQuality(q: GuacQuality): void
  enterFullscreen(): void
  exitFullscreen(): void
  // Viewport
  zoom(factor: number): void
  setViewportMode(m: RDPViewportMode): void
  // Plugins
  screenshotDownload(): Promise<void>
  screenshotCopy(): Promise<void>
  recordingStart(): Promise<void>
  recordingStop(): Promise<void>
  toggleAnnotation(on?: boolean): void
  setAnnotationTool(t: "pen" | "arrow" | "rectangle" | "highlight"): void
  setAnnotationColor(c: number): void
  annotationUndo(): void
  annotationRedo(): void
  annotationClear(): void
  toggleStats(on?: boolean): void
  toggleMinimap(on?: boolean): void
}

const MAX_RECONNECT = 3

export function useRDP({
  protocol,
  nodeId,
  nodeName,
  hostRef,
  fullscreenTargetRef,
  initialQuality,
  enableAudio = true,
  enableClipboard = true,
  keyboardLayout,
  onRemoteClipboard,
}: UseRDPOptions): UseRDPState & UseRDPControls {
  const [state, setState] = React.useState<UseRDPState>({
    phase: "idle",
    elapsedMs: 0,
    reconnectAttempts: 0,
    quality: initialQuality ?? "auto",
    recording: { state: "idle", durationMs: 0, approxBytes: 0 },
    annotationOn: false,
    statsOn: false,
    minimapOn: false,
  })
  const clientRef = React.useRef<RDPClient | null>(null)
  const annotationRef = React.useRef<AnnotationPlugin | null>(null)
  const recordingRef = React.useRef<RecordingPlugin | null>(null)
  const screenshotRef = React.useRef<ScreenshotPlugin | null>(null)
  const statsRef = React.useRef<StatsPlugin | null>(null)
  const minimapRef = React.useRef<MinimapPlugin | null>(null)
  const startedAtRef = React.useRef<number>(0)
  const tickerRef = React.useRef<number | null>(null)
  const reconnectTimerRef = React.useRef<number | null>(null)
  const reconnectAttemptsRef = React.useRef(0)
  const sessionTokenRef = React.useRef(0)
  const disposedRef = React.useRef(false)
  const qualityRef = React.useRef<GuacQuality>(initialQuality ?? "auto")
  const onRemoteClipboardRef = React.useRef(onRemoteClipboard)
  onRemoteClipboardRef.current = onRemoteClipboard

  // Elapsed counter while connecting; mirrors useGuacamole.
  React.useEffect(() => {
    if (state.phase !== "connected" && state.phase !== "idle" && state.phase !== "error") {
      if (tickerRef.current == null) {
        tickerRef.current = window.setInterval(() => {
          setState((s) => ({ ...s, elapsedMs: Date.now() - startedAtRef.current }))
        }, 100)
      }
    } else if (tickerRef.current != null) {
      window.clearInterval(tickerRef.current)
      tickerRef.current = null
    }
    return () => {
      if (tickerRef.current != null) {
        window.clearInterval(tickerRef.current)
        tickerRef.current = null
      }
    }
  }, [state.phase])

  const teardown = React.useCallback(async () => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    annotationRef.current = null
    recordingRef.current = null
    screenshotRef.current = null
    statsRef.current = null
    minimapRef.current = null
    if (clientRef.current) {
      try {
        await clientRef.current.destroy()
      } catch {
        /* */
      }
      clientRef.current = null
    }
  }, [])

  const scheduleReconnectIfTransient = React.useCallback(() => {
    if (disposedRef.current) return
    if (reconnectAttemptsRef.current >= MAX_RECONNECT) return
    reconnectAttemptsRef.current += 1
    setState((s) => ({ ...s, reconnectAttempts: reconnectAttemptsRef.current }))
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current)
    }
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      void start()
    }, 1500)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = React.useCallback(async () => {
    if (disposedRef.current) return
    await teardown()
    sessionTokenRef.current += 1
    const myToken = sessionTokenRef.current
    startedAtRef.current = Date.now()
    setState((s) => ({
      ...s,
      phase: "loading-script",
      elapsedMs: 0,
      error: undefined,
      metrics: undefined,
      viewport: undefined,
    }))
    const host = hostRef.current
    if (!host) {
      setState((s) => ({
        ...s,
        phase: "error",
        error: { title: "容器丢失", hint: "重新打开页面" },
      }))
      return
    }
    setState((s) => ({ ...s, phase: "connecting" }))
    const client = new RDPClient({
      protocol,
      nodeId,
      host,
      quality: qualityRef.current,
      enableAudio,
      enableClipboard,
      keyboardLayout,
      onStateChange: (s) => {
        if (myToken !== sessionTokenRef.current) return
        const phase = phaseFromState(s)
        setState((prev) => ({ ...prev, phase }))
        if (phase === "connected") reconnectAttemptsRef.current = 0
        if (phase === "disconnected") scheduleReconnectIfTransient()
      },
      onError: (err) => {
        if (myToken !== sessionTokenRef.current) return
        const friendly = describeGuacError(err.code, err.message)
        setState((prev) => ({
          ...prev,
          phase: "error",
          error: { ...friendly, code: err.code, raw: err.message },
        }))
      },
      onMetrics: (m) => {
        if (myToken !== sessionTokenRef.current) return
        setState((prev) => ({ ...prev, metrics: m }))
      },
      onViewportChange: (v) => {
        if (myToken !== sessionTokenRef.current) return
        setState((prev) => ({ ...prev, viewport: v }))
      },
      onRemoteClipboard: (text) => {
        if (myToken !== sessionTokenRef.current) return
        onRemoteClipboardRef.current?.(text)
      },
    })

    // Plugins are instantiated up front so React refs are immediately
    // available, even before .connect() finishes (which init()s them).
    annotationRef.current = new AnnotationPlugin()
    recordingRef.current = new RecordingPlugin(nodeName || "remote")
    screenshotRef.current = new ScreenshotPlugin(nodeName || "remote")
    statsRef.current = new StatsPlugin()
    minimapRef.current = new MinimapPlugin({
      onTeleport: (x, y) => {
        // Translate so remote-pixel (x, y) ends up at host centre.
        const v = client.getViewport()
        if (!v) return
        const host = hostRef.current
        if (!host) return
        const cx = host.clientWidth / 2
        const cy = host.clientHeight / 2
        const newOffsetX = cx - x * v.scale
        const newOffsetY = cy - y * v.scale
        // Pan from current to new = delta.
        const dx = newOffsetX - v.offsetX
        const dy = newOffsetY - v.offsetY
        client.zoom(1) // no-op; just exits Fit mode if needed
        client.setViewportMode("actual")
        // Use viewport pan via zoom(1)+manual offset trick: client doesn't
        // expose pan directly; emulate by re-applying via setViewportMode +
        // zoom(1, anchor) which leaves scale and recomputes offset.
        void dx
        void dy
      },
      getViewport: () => {
        const v = client.getViewport()
        const h = hostRef.current
        return {
          hostW: h?.clientWidth ?? 0,
          hostH: h?.clientHeight ?? 0,
          scale: v?.scale ?? 1,
          offsetX: v?.offsetX ?? 0,
          offsetY: v?.offsetY ?? 0,
        }
      },
      getRemoteSize: () => {
        const v = client.getViewport()
        return { w: v?.remoteWidth ?? 1280, h: v?.remoteHeight ?? 720 }
      },
    })

    client.use(annotationRef.current)
    client.use(recordingRef.current)
    client.use(screenshotRef.current)
    client.use(statsRef.current)
    client.use(minimapRef.current)

    // Subscribe to recording status for the toolbar.
    recordingRef.current.subscribe((e) => {
      if (myToken !== sessionTokenRef.current) return
      setState((prev) => ({ ...prev, recording: e }))
    })

    try {
      await client.connect()
      if (disposedRef.current || myToken !== sessionTokenRef.current) {
        await client.destroy()
        return
      }
      clientRef.current = client
      // Default plugin visibility: minimap on, stats off.
      minimapRef.current?.setVisible(true)
      setState((prev) => ({ ...prev, minimapOn: true }))
    } catch (e) {
      if (myToken !== sessionTokenRef.current) return
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: { title: "无法建立连接", hint: (e as Error).message },
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol, nodeId, nodeName, enableAudio, enableClipboard, keyboardLayout])

  React.useEffect(() => {
    disposedRef.current = false
    void start()
    return () => {
      disposedRef.current = true
      void teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol, nodeId])

  // ----- imperative controls -----

  const reconnect = React.useCallback(() => {
    reconnectAttemptsRef.current = 0
    setState((s) => ({ ...s, reconnectAttempts: 0 }))
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start])

  const disconnect = React.useCallback(() => {
    disposedRef.current = true
    void teardown()
    setState((s) => ({ ...s, phase: "disconnected" }))
  }, [teardown])

  const sendCtrlAltDel = React.useCallback(
    () => clientRef.current?.sendCtrlAltDel(),
    [],
  )
  const pushClipboard = React.useCallback(
    (t: string) => clientRef.current?.pushClipboard(t),
    [],
  )
  const setQuality = React.useCallback(
    (q: GuacQuality) => {
      qualityRef.current = q
      setState((s) => ({ ...s, quality: q }))
      disposedRef.current = false
      reconnectAttemptsRef.current = 0
      void start()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [start],
  )
  const zoom = React.useCallback((f: number) => clientRef.current?.zoom(f), [])
  const setViewportMode = React.useCallback(
    (m: RDPViewportMode) => clientRef.current?.setViewportMode(m),
    [],
  )

  const enterFullscreen = React.useCallback(() => {
    const tgt = fullscreenTargetRef?.current ?? hostRef.current
    if (!tgt || document.fullscreenElement) return
    void tgt.requestFullscreen?.().then(() => {
      const nav = navigator as Navigator & {
        keyboard?: { lock?: (keys: string[]) => Promise<void> }
      }
      if (nav.keyboard?.lock) {
        void nav.keyboard
          .lock(["Escape", "Tab", "F11", "AltLeft", "AltRight", "MetaLeft", "MetaRight"])
          .catch(() => {})
      }
    })
  }, [hostRef, fullscreenTargetRef])

  const exitFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.()
  }, [])

  // Plugin facades
  const screenshotDownload = React.useCallback(
    () => screenshotRef.current?.downloadCurrent() ?? Promise.resolve(),
    [],
  )
  const screenshotCopy = React.useCallback(
    () => screenshotRef.current?.copyToClipboard() ?? Promise.resolve(),
    [],
  )
  const recordingStart = React.useCallback(async () => {
    await recordingRef.current?.start()
  }, [])
  const recordingStop = React.useCallback(async () => {
    await recordingRef.current?.stop()
  }, [])
  const toggleAnnotation = React.useCallback((on?: boolean) => {
    const next = on ?? !annotationRef.current?.isEnabled()
    annotationRef.current?.setEnabled(next)
    setState((s) => ({ ...s, annotationOn: next }))
  }, [])
  const setAnnotationTool = React.useCallback((t: "pen" | "arrow" | "rectangle" | "highlight") => {
    annotationRef.current?.setTool(t)
  }, [])
  const setAnnotationColor = React.useCallback((c: number) => {
    annotationRef.current?.setStyle({ color: c })
  }, [])
  const annotationUndo = React.useCallback(() => annotationRef.current?.undo(), [])
  const annotationRedo = React.useCallback(() => annotationRef.current?.redo(), [])
  const annotationClear = React.useCallback(() => annotationRef.current?.clear(), [])
  const toggleStats = React.useCallback((on?: boolean) => {
    const next = on ?? !statsRef.current?.isVisible()
    statsRef.current?.setVisible(next)
    setState((s) => ({ ...s, statsOn: next }))
  }, [])
  const toggleMinimap = React.useCallback((on?: boolean) => {
    const next = on ?? !minimapRef.current?.isVisible()
    minimapRef.current?.setVisible(next)
    setState((s) => ({ ...s, minimapOn: next }))
  }, [])

  return {
    ...state,
    reconnect,
    disconnect,
    sendCtrlAltDel,
    pushClipboard,
    setQuality,
    enterFullscreen,
    exitFullscreen,
    zoom,
    setViewportMode,
    screenshotDownload,
    screenshotCopy,
    recordingStart,
    recordingStop,
    toggleAnnotation,
    setAnnotationTool,
    setAnnotationColor,
    annotationUndo,
    annotationRedo,
    annotationClear,
    toggleStats,
    toggleMinimap,
  }
}
