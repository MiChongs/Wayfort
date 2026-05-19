"use client"

// DesktopDisplay v2 — top-level React component for the workspace-v2
// `rdp_next` protocol. Mounts a canvas renderer, opens the WS data channel
// via FrameClient, attaches keyboard/mouse handlers, and coordinates a
// shadcn-styled toolbar + status bar + settings drawer + command palette +
// context menu. Mirrors the WebSSHTerminal v2 layout for a consistent
// workspace experience across protocols.

import * as React from "react"
import { useReducedMotion } from "motion/react"
import { toast } from "sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { createRenderer, type CanvasRendererHandle } from "@/lib/desktop/canvas-renderer"
import { collectClientCapabilities } from "@/lib/desktop/capabilities"
import { desktopControl } from "@/lib/desktop/control-client"
import { FrameClient } from "@/lib/desktop/frame-client"
import { nodeService } from "@/lib/api/services"
import { patchRdpProtoOptions } from "@/lib/desktop/proto-options"
import { useWorkspaceStore } from "@/components/workspace/useWorkspaceStore"
import {
  MOUSE_BUTTON_LEFT,
  MOUSE_BUTTON_MIDDLE,
  MOUSE_BUTTON_RIGHT,
  base64ToBytes,
  type ClientMessage,
  type CursorUpdate,
  type Phase,
  type SessionStatus,
} from "@/lib/desktop/types"
import { cn } from "@/lib/utils"
import { DesktopCommandPalette } from "./desktop-command-palette"
import { DesktopContextMenu } from "./desktop-context-menu"
import { DesktopLoadingOverlay } from "./desktop-loading-overlay"
import { DesktopPerfPanel } from "./desktop-perf-panel"
import { DesktopSettingsSheet } from "./desktop-settings-sheet"
import { DesktopStatusBar } from "./desktop-status-bar"
import { DesktopToolbar } from "./desktop-toolbar"
import { IronRdpDesktopShell } from "./desktop-display-iron"
import { bitmapCursorCss, rawBgraCursorCss, x11CursorToCss } from "./desktop-cursor-map"
import { expandCombo, keysymForEvent } from "./desktop-key-map"
import { useDesktopSettings } from "./use-desktop-settings"
import type { DesktopStatus, SessionStats } from "./desktop-types"

export interface DesktopDisplayProps {
  nodeId: number
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  backHref?: string
  /**
   * Picks the renderer.
   *   - "freerdp"  → libfreerdp worker subprocess + in-house frame protocol.
   *                  Default — matches the server's `desktop.default_backend`.
   *   - "ironrdp"  → Plan 29 path: IronRDP Wasm + Devolutions Gateway.
   *                  Requires `desktop.devolutions_gateway.enabled = true`.
   *   - "dummy"    → in-process test pattern (CI / smoke).
   * Caller (workspace tab launcher) picks one explicitly via the backend
   * selector; URL-mounted /rdp-next pages fall through to this default.
   */
  backend?: "freerdp" | "dummy" | "ironrdp"
  /** Workspace tab + perf panel observers. All optional. */
  onStatusChange?: (status: DesktopStatus) => void
  onStatsChange?: (stats: SessionStats) => void
  onLatencyChange?: (ms: number | null) => void
}

const RECONNECT_BACKOFFS_MS = [1000, 2000, 4000]

// Plan 29 PR-B — top-level dispatcher. Routes to the IronRDP shell
// (Wasm + Devolutions Gateway) or the legacy worker-subprocess shell
// based on the `backend` prop. Picking the renderer at this layer
// keeps each path's hook order stable (no conditional hooks).
export function DesktopDisplay(props: DesktopDisplayProps): React.ReactElement {
  // Default mirrors the server's `desktop.default_backend` (freerdp).
  // Using ironrdp by default triggers the "ironrdp backend not
  // configured" rejection on a fresh server without Devolutions
  // Gateway enabled, even though the gateway is fully optional.
  const backend = props.backend ?? "freerdp"
  if (backend === "ironrdp") {
    return (
      <IronRdpDesktopShell
        nodeId={props.nodeId}
        nodeName={props.nodeName}
        nodeHost={props.nodeHost}
        nodePort={props.nodePort}
        onStatusChange={props.onStatusChange}
        onStatsChange={props.onStatsChange}
        onLatencyChange={props.onLatencyChange}
      />
    )
  }
  return <LegacyDesktopDisplay {...props} backend={backend} />
}

function LegacyDesktopDisplay({
  nodeId,
  nodeName,
  nodeHost,
  nodePort,
  backend = "freerdp",
  onStatusChange,
  onStatsChange,
  onLatencyChange,
}: DesktopDisplayProps) {
  const { settings, update, reset } = useDesktopSettings()
  useReducedMotion() // currently unused; reserved for future micro-animations

  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const rendererRef = React.useRef<CanvasRendererHandle | null>(null)
  const clientRef = React.useRef<FrameClient | null>(null)
  const sessionIdRef = React.useRef<string>("")
  const reconnectAttemptRef = React.useRef(0)
  const sessionEpochRef = React.useRef(0)
  const detachInputsRef = React.useRef<(() => void) | null>(null)
  const lastCursorRef = React.useRef<CursorUpdate | null>(null)

  const [status, setStatus] = React.useState<DesktopStatus>("loading-script")
  const [startedAt, setStartedAt] = React.useState<number>(() => Date.now())
  const [errorInfo, setErrorInfo] = React.useState<{ message: string; code?: number } | undefined>()
  const [, force] = React.useState(0)
  const [fullscreen, setFullscreen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [perfOpen, setPerfOpen] = React.useState(false)
  const [remote, setRemote] = React.useState({ w: 1280, h: 720 })
  const [pointer, setPointer] = React.useState({ x: 0, y: 0 })
  const [stats, setStats] = React.useState<SessionStats>({
    bytesIn: 0,
    bytesOut: 0,
    latencyMs: null,
    fps: null,
  })
  const [pasteConfirm, setPasteConfirm] = React.useState<string | null>(null)
  const [bumpKey, setBumpKey] = React.useState(0)

  // Settings live in a ref so the WS connect effect (which depends on
  // nodeId / backend / bumpKey) doesn't re-fire on every checkbox toggle.
  const settingsRef = React.useRef(settings)
  React.useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // Loading-elapsed counter — drives the "已用时 X.Xs" text in the overlay.
  React.useEffect(() => {
    if (status === "connected" || status === "error" || status === "closed") return
    const t = window.setInterval(() => force((v) => v + 1), 250)
    return () => window.clearInterval(t)
  }, [status])

  // Fullscreen subscription.
  React.useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  // Bridge local state to the workspace tab + perf panel via optional
  // callback props. Each effect fires only when its watched value
  // actually changes so parents can `setState` inside the callback
  // without thrashing.
  React.useEffect(() => {
    onStatusChange?.(status)
  }, [status, onStatusChange])
  React.useEffect(() => {
    onStatsChange?.(stats)
  }, [stats, onStatsChange])
  React.useEffect(() => {
    onLatencyChange?.(stats.latencyMs)
  }, [stats.latencyMs, onLatencyChange])

  // Ctrl+Shift+P toggles the perf panel. Capture-phase so it wins
  // against the canvas's keyboard hook (which forwards everything
  // else to the remote desktop).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault()
        setPerfOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey, { capture: true })
    return () => window.removeEventListener("keydown", onKey, { capture: true })
  }, [])

  // Apply the current cursor whenever cursorMode flips. The renderer
  // doesn't track this — we cache the last cursor server-side update in
  // lastCursorRef and re-apply on mode change.
  React.useEffect(() => {
    const canvas = rendererRef.current?.canvas
    if (!canvas) return
    canvas.style.cursor = computeCursorCss(lastCursorRef.current, settings.cursorMode)
  }, [settings.cursorMode])

  // Main connect lifecycle. Re-runs when nodeId / backend / bumpKey change;
  // bumpKey is the manual "重新连接" trigger. The legacy FreeRDP path is kept
  // deliberately linear: one canvas renderer, one FrameClient, one session id.
  // React cleanup closes those concrete resources immediately; if cleanup wins
  // a race with POST /start, the returned session is explicitly deleted below.
  React.useEffect(() => {
    const epoch = ++sessionEpochRef.current
    let cancelled = false
    let reconnectTimer: number | null = null
    let detachRendererResize: (() => void) | null = null
    let detachRendererCursor: (() => void) | null = null
    let detachRendererError: (() => void) | null = null
    let detachRendererMetrics: (() => void) | null = null
    let detachRendererRefresh: (() => void) | null = null

    setStatus("loading-script")
    setErrorInfo(undefined)
    setStartedAt(Date.now())
    reconnectAttemptRef.current = 0

    const renderer = createRenderer(
      settingsRef.current.preferredWidth,
      settingsRef.current.preferredHeight,
    )
    rendererRef.current = renderer
    const initialHost = hostRef.current
    if (initialHost) {
      initialHost.innerHTML = ""
      initialHost.appendChild(renderer.canvas)
      applySmoothScaling(renderer.canvas, settingsRef.current.smoothScaling)
    }

    detachRendererResize = renderer.onResize((w, h) => {
      if (!cancelled) setRemote({ w, h })
    })
    detachRendererCursor = renderer.onCursor((cursor) => {
      lastCursorRef.current = cursor
      renderer.canvas.style.cursor = computeCursorCss(
        lastCursorRef.current,
        settingsRef.current.cursorMode,
      )
    })
    detachRendererError = renderer.onError((message) => {
      if (!cancelled) console.warn("[DesktopDisplay] renderer", message)
    })
    // 1 Hz performance snapshot. `framesPainted` collapses to FPS
    // since the renderer's window is exactly 1 s; `droppedFrames` is
    // monotonic so the panel charts cumulative drop count.
    detachRendererMetrics = renderer.onMetrics(({ avgDecodeMs, avgPaintMs, framesPainted, droppedFrames, codec, decoderPath }) => {
      if (cancelled) return
      setStats((prev) => ({
        ...prev,
        fps: framesPainted,
        avgDecodeMs,
        avgPaintMs,
        droppedFrames,
        codec,
        decoderPath,
      }))
    })
    // VideoDecoder error → ask gateway to send a full-screen RDP
    // Refresh Rect PDU so the server emits a new IDR immediately.
    // Without this the next IDR arrives at the server's natural
    // cadence (seconds) and the user stares at a frozen screen.
    detachRendererRefresh = renderer.onRefreshNeeded(() => {
      if (cancelled) return
      clientRef.current?.send({ refresh: {} })
    })

    function closeCurrentSession(endRemote: boolean) {
      detachInputsRef.current?.()
      detachInputsRef.current = null
      clientRef.current?.close()
      clientRef.current = null
      const sid = sessionIdRef.current
      sessionIdRef.current = ""
      if (endRemote && sid) {
        desktopControl.endSession(sid).catch(() => {})
      }
    }

    function isCurrentSession() {
      return !cancelled && sessionEpochRef.current === epoch
    }

    function scheduleReconnect() {
      if (!isCurrentSession()) return
      if (!settingsRef.current.reconnectOnDrop) return
      if (reconnectTimer != null) return
      const attempt = reconnectAttemptRef.current
      if (attempt >= RECONNECT_BACKOFFS_MS.length) {
        setStatus("error")
        setErrorInfo({ message: "多次重连失败,请检查网络或手动重试" })
        return
      }
      const delay = RECONNECT_BACKOFFS_MS[attempt]
      reconnectAttemptRef.current = attempt + 1
      setStatus("reconnecting")
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        if (!isCurrentSession()) return
        connect().catch((e) => {
          if (!isCurrentSession()) return
          setStatus("error")
          setErrorInfo({ message: (e as Error).message })
        })
      }, delay)
    }

    async function connect() {
      if (!isCurrentSession()) return
      closeCurrentSession(true)
      // Probe the browser's decoder support before posting the session
      // start so the gateway can suppress GFX/H.264 on browsers that
      // can't render it. `collectClientCapabilities` is async but fast
      // (~10 ms on Chromium, single-frame round-trip on Safari).
      const clientCaps = await collectClientCapabilities()
      if (!isCurrentSession()) return
      const start = await desktopControl.startSession({
        node_id: nodeId,
        width: settingsRef.current.preferredWidth,
        height: settingsRef.current.preferredHeight,
        dpi: 96,
        quality: "auto",
        backend,
        client_caps: clientCaps,
      })
      if (!isCurrentSession()) {
        desktopControl.endSession(start.session_id).catch(() => {})
        return
      }
      sessionIdRef.current = start.session_id

      const remoteW = start.remote_width || settingsRef.current.preferredWidth
      const remoteH = start.remote_height || settingsRef.current.preferredHeight
      setRemote({ w: remoteW, h: remoteH })
      renderer.resize(remoteW, remoteH)

      const host = hostRef.current
      if (!host) return
      if (renderer.canvas.parentElement !== host) {
        host.innerHTML = ""
        host.appendChild(renderer.canvas)
        applySmoothScaling(renderer.canvas, settingsRef.current.smoothScaling)
      }

      const client = new FrameClient({
        sessionId: start.session_id,
        onFrame: (frame) => renderer.paintFrame(frame),
        onFrameBytes: (frame, payload) => renderer.paintFrameBytes(frame, payload),
        onFrameBatch: (frames) => renderer.paintFrameBatchBytes(frames),
        onCursor: (cursor) => renderer.emitCursor(cursor),
        onStatus: (s: SessionStatus) => {
          if (!isCurrentSession()) return
          const next = phaseToStatus(s.phase)
          setStatus(next)
          if (next === "connected") {
            reconnectAttemptRef.current = 0
            setErrorInfo(undefined)
          }
          if (next === "error") {
            setErrorInfo({ message: s.message || "未知错误", code: s.code })
            toast.error(s.message || "桌面会话错误")
          }
          if (next === "closed") {
            scheduleReconnect()
          }
        },
        onError: (msg) => {
          if (!isCurrentSession()) return
          if (settingsRef.current.reconnectOnDrop) {
            scheduleReconnect()
            return
          }
          setStatus("error")
          setErrorInfo({ message: msg })
        },
        onStats: (s) => {
          if (!isCurrentSession()) return
          setStats((prev) => ({ ...prev, bytesIn: s.bytesIn, bytesOut: s.bytesOut }))
        },
        onClipboard: (data) => {
          if (!isCurrentSession()) return
          if (settingsRef.current.clipboardDirection === "off" ||
              settingsRef.current.clipboardDirection === "out-only") {
            return
          }
          if (data.mime === "text/plain" || data.mime === "text/plain;charset=utf-8") {
            try {
              const text = new TextDecoder("utf-8").decode(base64ToBytes(data.payload))
              navigator.clipboard?.writeText(text).catch(() => {})
            } catch {
              /* */
            }
            return
          }
          if (data.mime.startsWith("text/plain;charset=utf-16le")) {
            try {
              const bytes = base64ToBytes(data.payload)
              let end = bytes.length
              while (end >= 2 && bytes[end - 1] === 0 && bytes[end - 2] === 0) end -= 2
              const text = new TextDecoder("utf-16le").decode(bytes.subarray(0, end))
              navigator.clipboard?.writeText(text).catch(() => {})
            } catch {
              /* */
            }
          }
        },
      })
      client.connect()
      clientRef.current = client

      // Browser→remote clipboard. Bound to host so it picks up paste
      // events while focus is on the desktop. Multi-line pastes hit the
      // confirm dialog before reaching the worker.
      const onPaste = (e: ClipboardEvent) => {
        if (settingsRef.current.clipboardDirection === "off" ||
            settingsRef.current.clipboardDirection === "in-only") {
          return
        }
        const text = e.clipboardData?.getData("text/plain")
        if (!text) return
        const lines = text.split("\n").length
        const threshold = settingsRef.current.clipboardConfirmLines
        if (threshold > 0 && lines >= threshold) {
          setPasteConfirm(text)
          return
        }
        forwardClipboardText(text)
      }
      host.addEventListener("paste", onPaste)

      detachInputsRef.current = attachInputs(host, renderer.canvas, client, () => settingsRef.current, setPointer)

      // Stitch the cleanup helpers into the same teardown closure.
      const detach = detachInputsRef.current
      detachInputsRef.current = () => {
        host.removeEventListener("paste", onPaste)
        detach?.()
      }
    }

    connect().catch((e) => {
      if (!isCurrentSession()) return
      setStatus("error")
      setErrorInfo({ message: (e as Error).message || "无法建立桌面会话" })
    })

    return () => {
      cancelled = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      detachRendererResize?.()
      detachRendererCursor?.()
      detachRendererError?.()
      detachRendererMetrics?.()
      detachRendererRefresh?.()
      closeCurrentSession(true)
      renderer.destroy()
      rendererRef.current = null
      reconnectAttemptRef.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, backend, bumpKey])

  function forwardClipboardText(text: string) {
    const client = clientRef.current
    if (!client) return
    const utf16 = encodeUtf16Le(text)
    client.send({
      clipboard: {
        mime: "text/plain;charset=utf-16le",
        payload: btoaBytes(utf16),
      },
    })
  }
  function confirmPaste() {
    if (!pasteConfirm) return
    forwardClipboardText(pasteConfirm)
    setPasteConfirm(null)
  }

  function sendCombo(combo: string) {
    const client = clientRef.current
    if (!client) return
    const frames = expandCombo(combo)
    if (frames.length === 0) {
      toast.error("无法解析组合键", { description: combo })
      return
    }
    for (const f of frames) {
      client.send({ key: { keysym: f.keysym, pressed: f.pressed } })
    }
  }

  function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
  }

  function handleReconnect() {
    reconnectAttemptRef.current = 0
    setBumpKey((v) => v + 1)
  }
  function handleDisconnect() {
    sessionEpochRef.current += 1
    detachInputsRef.current?.()
    detachInputsRef.current = null
    clientRef.current?.close()
    clientRef.current = null
    if (sessionIdRef.current) {
      desktopControl.endSession(sessionIdRef.current).catch(() => {})
      sessionIdRef.current = ""
    }
    rendererRef.current?.destroy()
    rendererRef.current = null
    setStatus("closed")
  }

  // Escape hatch: close the failing rdp_next session and open the same
  // node via classic Guacamole RDP. The workspace's "rdp" protocol is the
  // longstanding stable path (RDPDisplay) — operators verified to work on
  // the same hosts that trip the freerdp-worker stack. We only attempt
  // this when running inside the workspace; on the standalone /nodes/
  // pages we navigate to the classic RDP page instead.
  function handleSwitchToGuacamole() {
    const store = useWorkspaceStore.getState()
    const inWorkspace = typeof store.open === "function" && Array.isArray(store.tabs)
    if (inWorkspace) {
      // Open a fresh tab on the workspace store; the existing rdp_next
      // tab stays in place so the user can compare. Activation auto-
      // happens because open() also focuses the new tab.
      store.open({
        nodeId,
        protocol: "rdp",
        title: nodeName || `node #${nodeId}`,
        host: nodeHost,
        port: nodePort,
      })
      toast.success("已在工作台开启经典 RDP 会话", {
        description: "通过 Guacamole 通道连接,通常更稳定",
      })
      return
    }
    // Standalone /nodes/[id]/rdp-next fallback — navigate to the classic
    // /nodes/[id]/rdp page. window.location keeps the navigation cheap
    // and avoids dragging next/router into this layer.
    if (typeof window !== "undefined") {
      window.location.assign(`/nodes/${nodeId}/rdp`)
    }
  }

  // Force-TLS retry shortcut: surfaces on the loading overlay when the
  // connection failed with ERRCONNECT_CONNECT_TRANSPORT_FAILED. Patches
  // the node's proto_options to set rdp.security = "tls" and reconnects,
  // so an operator unblocking an NLA-disabled Windows host doesn't have
  // to leave the session and edit the node in admin/nodes.
  async function handleForceTlsOnly() {
    try {
      const node = await nodeService.get(nodeId)
      const next = patchRdpProtoOptions(node.proto_options, { security: "tls" })
      await nodeService.update(nodeId, { proto_options: next })
      toast.success("已切换到仅 TLS,正在重连…")
      handleReconnect()
    } catch (e) {
      toast.error("切换失败", { description: (e as Error).message })
    }
  }

  // Smooth-scaling toggle applies to a (possibly already-mounted) canvas.
  React.useEffect(() => {
    const c = rendererRef.current?.canvas
    if (c) applySmoothScaling(c, settings.smoothScaling)
  }, [settings.smoothScaling])

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={wrapRef}
        className={cn(
          "flex flex-col h-full w-full bg-background isolate",
          fullscreen && "fixed inset-0 z-[60]",
        )}
      >
        <DesktopToolbar
          status={status}
          nodeName={nodeName}
          nodeId={nodeId}
          nodeHost={nodeHost}
          nodePort={nodePort}
          remoteWidth={remote.w}
          remoteHeight={remote.h}
          fullscreen={fullscreen}
          onSendCombo={sendCombo}
          onSendCtrlAltDel={() => sendCombo("Control+Alt+Delete")}
          onSettings={() => setSettingsOpen(true)}
          onPalette={() => setPaletteOpen(true)}
          onFullscreen={toggleFullscreen}
          onReconnect={handleReconnect}
          onDisconnect={handleDisconnect}
        />

        <DesktopContextMenu
          connected={status === "connected"}
          onSendCombo={sendCombo}
          onFullscreen={toggleFullscreen}
          onSettings={() => setSettingsOpen(true)}
          onPalette={() => setPaletteOpen(true)}
          onReconnect={handleReconnect}
          onDisconnect={handleDisconnect}
        >
          <div className={cn("relative flex-1 min-h-0 bg-black", scaleContainerClass(settings.scaleMode))}>
            <div
              ref={hostRef}
              className={cn("absolute inset-0 flex", scaleHostClass(settings.scaleMode))}
              tabIndex={0}
            />
            <DesktopLoadingOverlay
              status={status}
              errorMessage={errorInfo?.message}
              errorCode={errorInfo?.code}
              elapsedMs={Date.now() - startedAt}
              nodeName={nodeName}
              onRetry={handleReconnect}
              onForceTlsOnly={handleForceTlsOnly}
              onSwitchToGuacamole={handleSwitchToGuacamole}
            />
          </div>
        </DesktopContextMenu>

        <DesktopStatusBar
          status={status}
          remoteWidth={remote.w}
          remoteHeight={remote.h}
          pointerX={pointer.x}
          pointerY={pointer.y}
          stats={stats}
          keyboardLayout={settings.keyboardLayout}
          onOpenPerfPanel={() => setPerfOpen(true)}
        />

        <DesktopPerfPanel
          open={perfOpen}
          onOpenChange={setPerfOpen}
          sessionKey={nodeId}
          stats={stats}
          nodeName={nodeName}
        />

        <DesktopSettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          onChange={update}
          onReset={reset}
        />

        <DesktopCommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          actions={{
            onSendCombo: sendCombo,
            onFullscreen: toggleFullscreen,
            onSettings: () => setSettingsOpen(true),
            onReconnect: handleReconnect,
            onDisconnect: handleDisconnect,
          }}
        />

        <PasteConfirmDialog
          text={pasteConfirm}
          onConfirm={confirmPaste}
          onCancel={() => setPasteConfirm(null)}
        />
      </div>
    </TooltipProvider>
  )
}

function attachInputs(
  host: HTMLDivElement,
  canvas: HTMLCanvasElement,
  client: FrameClient,
  getSettings: () => ReturnType<typeof useDesktopSettings>["settings"],
  setPointer: (p: { x: number; y: number }) => void,
): () => void {
  let pressedButtons = 0

  function toRemote(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = host.getBoundingClientRect()
    const w = canvas.width || rect.width || 1
    const h = canvas.height || rect.height || 1
    const sx = rect.width > 0 ? w / rect.width : 1
    const sy = rect.height > 0 ? h / rect.height : 1
    return {
      x: Math.max(0, Math.round((e.clientX - rect.left) * sx)),
      y: Math.max(0, Math.round((e.clientY - rect.top) * sy)),
    }
  }

  function buttonMask(button: number): number {
    const swap = getSettings().swapMiddleButton
    if (button === 0) return MOUSE_BUTTON_LEFT
    if (button === 1) return swap ? MOUSE_BUTTON_RIGHT : MOUSE_BUTTON_MIDDLE
    if (button === 2) return MOUSE_BUTTON_RIGHT
    return 0
  }

  const onMove = (e: MouseEvent) => {
    const { x, y } = toRemote(e)
    setPointer({ x, y })
    client.send({ mouse: { x, y, buttons: pressedButtons, wheel: 0 } })
  }
  const onDown = (e: MouseEvent) => {
    pressedButtons |= buttonMask(e.button)
    const { x, y } = toRemote(e)
    client.send({ mouse: { x, y, buttons: pressedButtons, wheel: 0 } })
    e.preventDefault()
  }
  const onUp = (e: MouseEvent) => {
    pressedButtons &= ~buttonMask(e.button)
    const { x, y } = toRemote(e)
    client.send({ mouse: { x, y, buttons: pressedButtons, wheel: 0 } })
  }
  const onWheel = (e: WheelEvent) => {
    const { x, y } = toRemote(e)
    client.send({ mouse: { x, y, buttons: pressedButtons, wheel: e.deltaY > 0 ? -1 : 1 } })
    e.preventDefault()
  }
  const onContext = (e: MouseEvent) => e.preventDefault()
  const onKeyDown = (e: KeyboardEvent) => {
    const ks = keysymForEvent(e, { activeElement: document.activeElement })
    if (ks > 0) {
      client.send({ key: { keysym: ks, pressed: true } } satisfies ClientMessage)
      e.preventDefault()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    const ks = keysymForEvent(e, { activeElement: document.activeElement })
    if (ks > 0) {
      client.send({ key: { keysym: ks, pressed: false } } satisfies ClientMessage)
      e.preventDefault()
    }
  }

  host.addEventListener("mousemove", onMove)
  host.addEventListener("mousedown", onDown)
  host.addEventListener("mouseup", onUp)
  host.addEventListener("wheel", onWheel, { passive: false })
  host.addEventListener("contextmenu", onContext)
  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("keyup", onKeyUp)

  return () => {
    host.removeEventListener("mousemove", onMove)
    host.removeEventListener("mousedown", onDown)
    host.removeEventListener("mouseup", onUp)
    host.removeEventListener("wheel", onWheel)
    host.removeEventListener("contextmenu", onContext)
    window.removeEventListener("keydown", onKeyDown)
    window.removeEventListener("keyup", onKeyUp)
  }
}

function PasteConfirmDialog({
  text,
  onConfirm,
  onCancel,
}: {
  text: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const lines = text ? text.split("\n").length : 0
  const preview = text ? (text.length > 600 ? text.slice(0, 600) + "\n…" : text) : ""
  return (
    <Dialog open={!!text} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>粘贴 {lines} 行内容到远端?</DialogTitle>
          <DialogDescription>
            多行粘贴会立刻送到远端剪贴板,可能被脚本立即执行,确认无误后再继续。
          </DialogDescription>
        </DialogHeader>
        <pre className="bg-muted rounded-md p-2 text-xs font-mono whitespace-pre overflow-auto max-h-60 text-foreground">
          {preview}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button onClick={onConfirm}>确认粘贴</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function phaseToStatus(p: Phase): DesktopStatus {
  switch (p) {
    case "CONNECTING":   return "connecting"
    case "HANDSHAKE":    return "handshake"
    case "CONNECTED":    return "connected"
    case "RECONNECTING": return "reconnecting"
    case "CLOSED":       return "closed"
    case "ERROR":        return "error"
  }
}

function computeCursorCss(
  cursor: CursorUpdate | null,
  mode: "remote" | "css-only" | "hidden",
): string {
  if (mode === "hidden") return "none"
  if (mode === "css-only") return "default"
  if (!cursor) return "default"
  if (cursor.hidden) return "none"
  if (cursor.encoding === "system") return x11CursorToCss(cursor.system_kind)
  if (cursor.encoding === "png" && cursor.payload) {
    return bitmapCursorCss(cursor.payload, cursor.hotspot_x ?? 0, cursor.hotspot_y ?? 0)
  }
  if (cursor.encoding === "raw_bgra" && cursor.payload && cursor.width && cursor.height) {
    return rawBgraCursorCss(
      cursor.payload,
      cursor.width,
      cursor.height,
      cursor.hotspot_x ?? 0,
      cursor.hotspot_y ?? 0,
    )
  }
  return "default"
}

function applySmoothScaling(canvas: HTMLCanvasElement, smooth: boolean) {
  canvas.style.imageRendering = smooth ? "auto" : "pixelated"
}

function scaleContainerClass(mode: "fit" | "actual" | "center" | "stretch"): string {
  switch (mode) {
    case "fit":     return "overflow-hidden"
    case "actual":  return "overflow-auto"
    case "center":  return "overflow-auto"
    case "stretch": return "overflow-hidden"
  }
}
function scaleHostClass(mode: "fit" | "actual" | "center" | "stretch"): string {
  switch (mode) {
    case "fit":     return "items-center justify-center"
    case "actual":  return "items-start justify-start"
    case "center":  return "items-center justify-center"
    case "stretch": return "items-stretch justify-stretch"
  }
}

function btoaBytes(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function encodeUtf16Le(text: string): Uint8Array {
  // Server expects UTF-16LE (MS-RDPECLIP §2.2.5.2.1). Null-terminate the
  // string the way RDP clipboard formats do.
  const buf = new Uint8Array((text.length + 1) * 2)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    buf[i * 2] = c & 0xff
    buf[i * 2 + 1] = (c >> 8) & 0xff
  }
  return buf
}
