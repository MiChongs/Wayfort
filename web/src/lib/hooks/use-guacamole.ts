"use client"

import * as React from "react"
import {
  connectGuacamole,
  ensureGuacamoleScript,
  type GuacHandle,
  type GuacMetrics,
  type GuacQuality,
} from "@/lib/ws/guacamole-client"
import {
  describeGuacError,
  phaseFromState,
  type FriendlyError,
  type GuacPhase,
} from "@/components/guacamole/guac-errors"

export interface GuacState {
  phase: GuacPhase
  elapsedMs: number
  reconnectAttempts: number
  error?: FriendlyError & { code?: number; raw?: string }
  // Plan 13.D.1/D.2/D.3 — live metrics updated ~1Hz.
  metrics?: GuacMetrics
  quality: GuacQuality
}

export interface GuacControls {
  reconnect(): void
  disconnect(): void
  sendCtrlAltDel(): void
  enterFullscreen(): void
  exitFullscreen(): void
  // Plan 13.D.6 — push local clipboard text to the remote desktop.
  pushClipboard(text: string): void
  // Plan 13.B.2 — change quality preset; triggers a clean reconnect.
  setQuality(q: GuacQuality): void
}

export interface UseGuacamoleOptions {
  protocol: "rdp" | "vnc"
  nodeId: number
  containerRef: React.RefObject<HTMLElement | null>
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>
  // optional override; default reads bounding rect
  width?: number
  height?: number
  // Plan 13.B.2 — initial quality preset; defaults to "auto" (medium).
  initialQuality?: GuacQuality
  // Plan 13.B.3 — feature toggles. Default both on.
  enableAudio?: boolean
  enableClipboard?: boolean
  keyboardLayout?: string
  // Plan 13.D.6 — invoked when remote desktop pushes clipboard text.
  onRemoteClipboard?: (text: string) => void
}

const MAX_RECONNECT = 3

export function useGuacamole({
  protocol,
  nodeId,
  containerRef,
  fullscreenTargetRef,
  initialQuality,
  enableAudio = true,
  enableClipboard = true,
  keyboardLayout,
  onRemoteClipboard,
}: UseGuacamoleOptions): GuacState & GuacControls {
  const [state, setState] = React.useState<GuacState>({
    phase: "idle",
    elapsedMs: 0,
    reconnectAttempts: 0,
    quality: initialQuality ?? "auto",
  })
  const handleRef = React.useRef<GuacHandle | null>(null)
  const startedAtRef = React.useRef<number>(0)
  const tickerRef = React.useRef<number | null>(null)
  const reconnectTimerRef = React.useRef<number | null>(null)
  const disposedRef = React.useRef(false)
  const reconnectAttemptsRef = React.useRef(0)
  const sessionTokenRef = React.useRef(0)
  const qualityRef = React.useRef<GuacQuality>(initialQuality ?? "auto")
  // Keep latest callbacks in refs so the start() closure doesn't capture
  // stale versions when the consumer re-renders.
  const onRemoteClipboardRef = React.useRef(onRemoteClipboard)
  onRemoteClipboardRef.current = onRemoteClipboard

  // Effect: keep state.elapsedMs ticking while not connected/idle/error.
  React.useEffect(() => {
    if (state.phase !== "connected" && state.phase !== "idle" && state.phase !== "error") {
      if (tickerRef.current == null) {
        tickerRef.current = window.setInterval(() => {
          setState((s) => ({ ...s, elapsedMs: Date.now() - startedAtRef.current }))
        }, 100)
      }
    } else {
      if (tickerRef.current != null) {
        window.clearInterval(tickerRef.current)
        tickerRef.current = null
      }
    }
    return () => {
      if (tickerRef.current != null) {
        window.clearInterval(tickerRef.current)
        tickerRef.current = null
      }
    }
  }, [state.phase])

  const teardown = React.useCallback(() => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (handleRef.current) {
      try {
        handleRef.current.disconnect()
      } catch {
        /* */
      }
      handleRef.current = null
    }
  }, [])

  // We define start as a ref-stable callback (deps only on protocol/nodeId).
  // Plan 13.C.3 — sessionTokenRef bumps on every start, and async callbacks
  // gate on a `myToken === sessionTokenRef.current` check so a late-arriving
  // setState from a torn-down attempt cannot pollute the new attempt.
  const start = React.useCallback(async () => {
    if (disposedRef.current) return
    teardown()
    sessionTokenRef.current += 1
    const myToken = sessionTokenRef.current
    startedAtRef.current = Date.now()
    setState((s) => ({
      ...s,
      phase: "loading-script",
      elapsedMs: 0,
      error: undefined,
      metrics: undefined,
    }))
    try {
      await ensureGuacamoleScript()
    } catch (e) {
      if (myToken !== sessionTokenRef.current) return
      setState((s) => ({
        ...s,
        phase: "error",
        error: { title: "客户端加载失败", hint: (e as Error).message },
      }))
      return
    }
    if (disposedRef.current || myToken !== sessionTokenRef.current) return

    const el = containerRef.current
    if (!el) {
      setState((s) => ({
        ...s,
        phase: "error",
        error: { title: "容器丢失", hint: "重新打开页面" },
      }))
      return
    }
    const w = Math.max(800, el.clientWidth || 1280)
    const h = Math.max(600, el.clientHeight || 720)
    setState((s) => ({ ...s, phase: "connecting" }))

    try {
      const handle = await connectGuacamole({
        protocol,
        nodeId,
        container: el,
        width: w,
        height: h,
        quality: qualityRef.current,
        enableAudio,
        enableClipboard,
        keyboardLayout,
        onStateChange: (s) => {
          if (myToken !== sessionTokenRef.current) return
          const phase = phaseFromState(s)
          setState((prev) => ({ ...prev, phase }))
          if (phase === "connected") {
            reconnectAttemptsRef.current = 0
          }
          if (phase === "disconnected") {
            // Auto-reconnect once if it dropped without an explicit error
            // (transient network blips).
            scheduleReconnectIfTransient()
          }
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
        onRemoteClipboard: (text) => {
          if (myToken !== sessionTokenRef.current) return
          onRemoteClipboardRef.current?.(text)
        },
      })
      if (disposedRef.current || myToken !== sessionTokenRef.current) {
        handle.disconnect()
        return
      }
      handleRef.current = handle
    } catch (e) {
      if (myToken !== sessionTokenRef.current) return
      setState((s) => ({
        ...s,
        phase: "error",
        error: { title: "无法建立连接", hint: (e as Error).message },
      }))
    }
  }, [containerRef, nodeId, protocol, teardown, enableAudio, enableClipboard, keyboardLayout])

  function scheduleReconnectIfTransient() {
    if (disposedRef.current) return
    if (reconnectAttemptsRef.current >= MAX_RECONNECT) return
    reconnectAttemptsRef.current += 1
    setState((s) => ({
      ...s,
      reconnectAttempts: reconnectAttemptsRef.current,
    }))
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current)
    }
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      void start()
    }, 1500)
  }

  // Mount: start the connection. Unmount: tear down.
  React.useEffect(() => {
    disposedRef.current = false
    void start()
    return () => {
      disposedRef.current = true
      teardown()
    }
    // start is stable per (protocol, nodeId, containerRef.current); we
    // intentionally depend on protocol+nodeId so swapping target restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol, nodeId])

  // ResizeObserver: notify guacd when the visible area changes. Plan 13.C.4 —
  // de-dup: only dispatch when the integer dimensions actually change to
  // avoid an event flood when the container is animating.
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let prevW = 0
    let prevH = 0
    const ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (!e) return
      const w = Math.max(400, Math.floor(e.contentRect.width))
      const h = Math.max(300, Math.floor(e.contentRect.height))
      if (w === prevW && h === prevH) return
      prevW = w
      prevH = h
      handleRef.current?.sendResize(w, h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef])

  const reconnect = React.useCallback(() => {
    reconnectAttemptsRef.current = 0
    setState((s) => ({ ...s, reconnectAttempts: 0 }))
    void start()
  }, [start])

  const disconnect = React.useCallback(() => {
    disposedRef.current = true
    teardown()
    setState((s) => ({ ...s, phase: "disconnected" }))
  }, [teardown])

  const sendCtrlAltDel = React.useCallback(() => {
    handleRef.current?.sendCtrlAltDel()
  }, [])

  const pushClipboard = React.useCallback((text: string) => {
    handleRef.current?.pushClipboard(text)
  }, [])

  const setQuality = React.useCallback(
    (q: GuacQuality) => {
      qualityRef.current = q
      setState((s) => ({ ...s, quality: q }))
      // Quality changes require a new WS negotiation with guacd — clean
      // reconnect lets the server-side handshake pick up the new params.
      disposedRef.current = false
      reconnectAttemptsRef.current = 0
      void start()
    },
    [start],
  )

  const enterFullscreen = React.useCallback(() => {
    const tgt =
      (fullscreenTargetRef && fullscreenTargetRef.current) ||
      containerRef.current
    if (!tgt) return
    if (document.fullscreenElement) return
    void tgt.requestFullscreen?.().then(() => {
      // Plan 13.D.4 — Keyboard Lock API: capture browser-reserved keys so
      // Ctrl+W, Alt+Tab, F11 etc. are forwarded to the remote desktop
      // instead of triggering the browser. Requires HTTPS or localhost.
      // Silent fail if the browser doesn't support it.
      type KeyboardLockable = Navigator & {
        keyboard?: { lock?: (keys: string[]) => Promise<void> }
      }
      const nav = navigator as KeyboardLockable
      if (nav.keyboard && typeof nav.keyboard.lock === "function") {
        void nav.keyboard
          .lock([
            "Escape",
            "Tab",
            "F11",
            "AltLeft",
            "AltRight",
            "MetaLeft",
            "MetaRight",
          ])
          .catch(() => {
            /* old browser / not allowed; ignore */
          })
      }
    })
  }, [containerRef, fullscreenTargetRef])

  const exitFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()
    }
    // Releasing keyboard lock is automatic on fullscreen exit per spec.
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
  }
}
