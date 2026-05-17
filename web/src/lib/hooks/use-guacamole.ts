"use client"

import * as React from "react"
import {
  connectGuacamole,
  ensureGuacamoleScript,
  type GuacHandle,
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
}

export interface GuacControls {
  reconnect(): void
  disconnect(): void
  sendCtrlAltDel(): void
  enterFullscreen(): void
  exitFullscreen(): void
}

export interface UseGuacamoleOptions {
  protocol: "rdp" | "vnc"
  nodeId: number
  containerRef: React.RefObject<HTMLElement | null>
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>
  // optional override; default reads bounding rect
  width?: number
  height?: number
}

const MAX_RECONNECT = 3

export function useGuacamole({
  protocol,
  nodeId,
  containerRef,
  fullscreenTargetRef,
}: UseGuacamoleOptions): GuacState & GuacControls {
  const [state, setState] = React.useState<GuacState>({
    phase: "idle",
    elapsedMs: 0,
    reconnectAttempts: 0,
  })
  const handleRef = React.useRef<GuacHandle | null>(null)
  const startedAtRef = React.useRef<number>(0)
  const tickerRef = React.useRef<number | null>(null)
  const reconnectTimerRef = React.useRef<number | null>(null)
  const disposedRef = React.useRef(false)
  const reconnectAttemptsRef = React.useRef(0)
  const sessionTokenRef = React.useRef(0)

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
  }, [containerRef, nodeId, protocol, teardown])

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

  // ResizeObserver: notify guacd when the visible area changes.
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (!e) return
      const w = Math.max(400, Math.floor(e.contentRect.width))
      const h = Math.max(300, Math.floor(e.contentRect.height))
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

  const enterFullscreen = React.useCallback(() => {
    const tgt =
      (fullscreenTargetRef && fullscreenTargetRef.current) ||
      containerRef.current
    if (!tgt) return
    if (document.fullscreenElement) return
    void tgt.requestFullscreen?.()
  }, [containerRef, fullscreenTargetRef])

  const exitFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()
    }
  }, [])

  return {
    ...state,
    reconnect,
    disconnect,
    sendCtrlAltDel,
    enterFullscreen,
    exitFullscreen,
  }
}
