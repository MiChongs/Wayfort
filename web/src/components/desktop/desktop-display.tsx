"use client"

// DesktopDisplay v2 — top-level React component for the workspace-v2
// `rdp_next` protocol. Mounts an OffscreenCanvas renderer, opens the WS
// data channel via FrameClient, attaches keyboard/mouse handlers, and
// coordinates a shadcn-styled toolbar + status bar + settings drawer +
// command palette + context menu. Mirrors the WebSSHTerminal v2 layout
// for a consistent workspace experience across protocols.

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
import { DesktopSettingsSheet } from "./desktop-settings-sheet"
import { DesktopStatusBar } from "./desktop-status-bar"
import { DesktopToolbar } from "./desktop-toolbar"
import { bitmapCursorCss, x11CursorToCss } from "./desktop-cursor-map"
import { expandCombo, keysymForEvent } from "./desktop-key-map"
import { useDesktopSettings } from "./use-desktop-settings"
import type { DesktopStatus, SessionStats } from "./desktop-types"

export interface DesktopDisplayProps {
  nodeId: number
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  backHref?: string
  backend?: "freerdp" | "dummy"
}

const RECONNECT_BACKOFFS_MS = [1000, 2000, 4000]

// Module-level cache of live RDP sessions keyed by (nodeId, backend,
// bumpKey). Lives outside the React component so it survives Strict-Mode
// dev-only unmount-remount cycles (React 19 / Next 16 with
// `reactStrictMode: true` double-invokes effects to surface bugs — see
// console stack containing `doubleInvokeEffectsOnFiber`). Without this
// cache, every strict-mode mount tears down the WS + worker subprocess
// before the connect even completes, leaking orphan workers on the
// gateway and showing the user a "画面出现一下就掉" symptom.
//
// On unmount, cleanup schedules teardown via `teardownTimer` after
// TEARDOWN_GRACE_MS. If the effect re-mounts within that window (which
// is exactly what Strict-Mode does), the new mount finds the entry,
// cancels the timer, and reattaches all the live refs — no new POST
// /start, no new WS, the canvas pops back in.
type LiveDesktopSession = {
  sessionId: string
  client: FrameClient
  renderer: CanvasRendererHandle
  detachInputs: (() => void) | null
  teardownTimer: number | null
  remoteWidth: number
  remoteHeight: number
  lastStatus: DesktopStatus
}
const liveDesktopSessions = new Map<string, LiveDesktopSession>()
const TEARDOWN_GRACE_MS = 200

export function DesktopDisplay({
  nodeId,
  nodeName,
  nodeHost,
  nodePort,
  backend = "freerdp",
}: DesktopDisplayProps) {
  const { settings, update, reset } = useDesktopSettings()
  useReducedMotion() // currently unused; reserved for future micro-animations

  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const rendererRef = React.useRef<CanvasRendererHandle | null>(null)
  const clientRef = React.useRef<FrameClient | null>(null)
  const sessionIdRef = React.useRef<string>("")
  const reconnectAttemptRef = React.useRef(0)
  const detachInputsRef = React.useRef<(() => void) | null>(null)
  const lastCursorRef = React.useRef<CursorUpdate | null>(null)

  const [status, setStatus] = React.useState<DesktopStatus>("loading-script")
  const [startedAt, setStartedAt] = React.useState<number>(() => Date.now())
  const [errorInfo, setErrorInfo] = React.useState<{ message: string; code?: number } | undefined>()
  const [, force] = React.useState(0)
  const [fullscreen, setFullscreen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
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

  // Apply the current cursor whenever cursorMode flips. The renderer
  // doesn't track this — we cache the last cursor server-side update in
  // lastCursorRef and re-apply on mode change.
  React.useEffect(() => {
    const canvas = rendererRef.current?.canvas
    if (!canvas) return
    canvas.style.cursor = computeCursorCss(lastCursorRef.current, settings.cursorMode)
  }, [settings.cursorMode])

  // Main connect lifecycle. Re-runs when nodeId / backend / bumpKey change;
  // bumpKey is the manual "重新连接" trigger.
  //
  // Strict-mode survival: if we just unmounted-then-remounted within
  // TEARDOWN_GRACE_MS (i.e. React 19 dev double-invoke fired), the
  // live session is still alive in `liveDesktopSessions`. We cancel its
  // pending teardown timer, re-attach all refs (sessionId, client,
  // renderer, detachInputs), re-append the canvas to the new hostRef,
  // and skip the connect flow. The user sees zero perceptible break;
  // the gateway sees zero extra POST /start (no orphan workers).
  React.useEffect(() => {
    const cacheKey = `${nodeId}:${backend}:${bumpKey}`
    let cancelled = false
    let reconnectTimer: number | null = null

    const cached = liveDesktopSessions.get(cacheKey)
    if (cached && cached.teardownTimer != null) {
      console.info("[DesktopDisplay] strict-mode remount detected — reusing live session", {
        cacheKey,
        sessionId: cached.sessionId,
        status: cached.lastStatus,
      })
      window.clearTimeout(cached.teardownTimer)
      cached.teardownTimer = null

      sessionIdRef.current = cached.sessionId
      clientRef.current = cached.client
      rendererRef.current = cached.renderer
      detachInputsRef.current = cached.detachInputs
      setRemote({ w: cached.remoteWidth, h: cached.remoteHeight })
      setStatus(cached.lastStatus)
      setErrorInfo(undefined)

      // Re-append the (still-mounted-in-DOM-but-detached-now) canvas
      // node to the freshly-mounted hostRef div.
      const host = hostRef.current
      if (host && cached.renderer.canvas.parentElement !== host) {
        host.innerHTML = ""
        host.appendChild(cached.renderer.canvas)
        applySmoothScaling(cached.renderer.canvas, settingsRef.current.smoothScaling)
      }

      return () => {
        const live = liveDesktopSessions.get(cacheKey)
        if (!live) return
        if (live.teardownTimer != null) window.clearTimeout(live.teardownTimer)
        live.teardownTimer = window.setTimeout(() => {
          liveDesktopSessions.delete(cacheKey)
          live.detachInputs?.()
          live.client.close()
          live.renderer.destroy()
          desktopControl.endSession(live.sessionId).catch(() => {})
        }, TEARDOWN_GRACE_MS)
      }
    }

    setStatus("loading-script")
    setErrorInfo(undefined)
    setStartedAt(Date.now())

    function scheduleReconnect() {
      if (cancelled) return
      if (!settingsRef.current.reconnectOnDrop) return
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
        if (cancelled) return
        connect().catch((e) => {
          if (cancelled) return
          setStatus("error")
          setErrorInfo({ message: (e as Error).message })
        })
      }, delay)
    }

    async function connect() {
      const start = await desktopControl.startSession({
        node_id: nodeId,
        width: settingsRef.current.preferredWidth,
        height: settingsRef.current.preferredHeight,
        dpi: 96,
        quality: "auto",
        backend,
      })
      if (cancelled) {
        // Strict-mode (or any) unmount fired while POST /start was
        // in flight. The gateway already created the session + spawned
        // a worker subprocess — kill it now or it leaks until the
        // gateway times the session out. Without this, every
        // dev-mode mount in StrictMode permanently orphans one
        // freerdp-worker process.
        desktopControl.endSession(start.session_id).catch(() => {})
        return
      }
      sessionIdRef.current = start.session_id

      const remoteW = start.remote_width || settingsRef.current.preferredWidth
      const remoteH = start.remote_height || settingsRef.current.preferredHeight
      setRemote({ w: remoteW, h: remoteH })

      // Only build a fresh renderer on first connect. Reconnect attempts
      // re-use the existing canvas so the user doesn't see a black flash.
      if (!rendererRef.current) {
        const renderer = createRenderer(remoteW, remoteH)
        rendererRef.current = renderer
        const host = hostRef.current
        if (!host) return
        host.innerHTML = ""
        host.appendChild(renderer.canvas)
        applySmoothScaling(renderer.canvas, settingsRef.current.smoothScaling)
        renderer.onResize((w, h) => {
          renderer.canvas.width = w
          renderer.canvas.height = h
          setRemote({ w, h })
        })
        renderer.onCursor(({ x, y, png }) => {
          // The legacy renderer emits a CursorUpdate-shaped event. Reconstruct
          // the full record so the mode-toggle effect can re-apply later.
          lastCursorRef.current = { hotspot_x: x, hotspot_y: y, png } as unknown as CursorUpdate
          renderer.canvas.style.cursor = computeCursorCss(
            lastCursorRef.current,
            settingsRef.current.cursorMode,
          )
        })
      }
      const renderer = rendererRef.current
      const host = hostRef.current
      if (!host) return

      const client = new FrameClient({
        sessionId: start.session_id,
        renderWorker: renderer.worker,
        onStatus: (s: SessionStatus) => {
          const next = phaseToStatus(s.phase)
          setStatus(next)
          // Keep the LiveCache's last-known phase in sync so a future
          // strict-mode remount can restore the right loader/connected
          // state without flashing back to "loading-script".
          const live = liveDesktopSessions.get(cacheKey)
          if (live) live.lastStatus = next
          if (next === "connected") {
            reconnectAttemptRef.current = 0
            setErrorInfo(undefined)
          }
          if (next === "error") {
            setErrorInfo({ message: s.message || "未知错误", code: s.code })
            toast.error(s.message || "桌面会话错误")
          }
          if (next === "closed" && !cancelled) {
            if (settingsRef.current.reconnectOnDrop && reconnectAttemptRef.current === 0) {
              // First close → try one immediate reconnect with the same
              // session metadata.
              scheduleReconnect()
            }
          }
        },
        onError: (msg) => {
          if (cancelled) return
          if (settingsRef.current.reconnectOnDrop) {
            scheduleReconnect()
            return
          }
          setStatus("error")
          setErrorInfo({ message: msg })
        },
        onStats: (s) => {
          setStats((prev) => ({ ...prev, bytesIn: s.bytesIn, bytesOut: s.bytesOut }))
        },
        onClipboard: (data) => {
          if (settingsRef.current.clipboardDirection === "off" ||
              settingsRef.current.clipboardDirection === "out-only") {
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

      // Publish to the LiveCache. From this point on, an unmount
      // schedules a deferred teardown that a fast remount can cancel.
      liveDesktopSessions.set(cacheKey, {
        sessionId: start.session_id,
        client,
        renderer,
        detachInputs: detachInputsRef.current,
        teardownTimer: null,
        remoteWidth: remoteW,
        remoteHeight: remoteH,
        lastStatus: "loading-script",
      })
      console.info("[DesktopDisplay] cache populated", {
        cacheKey,
        sessionId: start.session_id,
      })
    }

    connect().catch((e) => {
      if (cancelled) return
      setStatus("error")
      setErrorInfo({ message: (e as Error).message || "无法建立桌面会话" })
    })

    return () => {
      cancelled = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)

      const live = liveDesktopSessions.get(cacheKey)
      if (live) {
        console.info("[DesktopDisplay] cleanup: Path A (cache hit) — deferring teardown 200ms", {
          cacheKey,
          sessionId: live.sessionId,
        })
        // Connect completed and the session is in the cache. Schedule a
        // deferred teardown — a remount within TEARDOWN_GRACE_MS (the
        // strict-mode case) will reach in, cancel the timer, and
        // reattach without paying for a fresh POST /start.
        if (live.teardownTimer != null) window.clearTimeout(live.teardownTimer)
        live.teardownTimer = window.setTimeout(() => {
          console.info("[DesktopDisplay] deferred teardown firing (Path A)", {
            cacheKey,
            sessionId: live.sessionId,
          })
          liveDesktopSessions.delete(cacheKey)
          live.detachInputs?.()
          live.client.close()
          live.renderer.destroy()
          desktopControl.endSession(live.sessionId).catch(() => {})
        }, TEARDOWN_GRACE_MS)
        return
      }

      console.info("[DesktopDisplay] cleanup: Path B (cache miss) — immediate close", {
        cacheKey,
        hasClient: !!clientRef.current,
        sessionId: sessionIdRef.current,
      })
      // Connect was still in flight (or failed). Do an immediate
      // cleanup of whatever was started — the in-flight POST will hit
      // the `if (cancelled)` orphan-killer above and self-clean on
      // arrival.
      detachInputsRef.current?.()
      detachInputsRef.current = null
      clientRef.current?.close()
      clientRef.current = null
      if (sessionIdRef.current) {
        desktopControl.endSession(sessionIdRef.current).catch(() => {})
        sessionIdRef.current = ""
      }
      reconnectAttemptRef.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, backend, bumpKey])

  // Renderer disposal is owned by the LiveCache deferred-teardown path
  // in the connect effect above. A separate empty-deps effect that
  // destroyed the renderer on every unmount would fire on every
  // strict-mode unmount-remount cycle, racing the LiveCache restore and
  // handing it a destroyed handle.

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
    clientRef.current?.close()
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
  if (cursor.png && cursor.png.length > 0) {
    const b64 =
      typeof cursor.png === "string" ? cursor.png : btoaBytes(cursor.png as unknown as Uint8Array)
    return bitmapCursorCss(b64, cursor.hotspot_x ?? 0, cursor.hotspot_y ?? 0)
  }
  if (cursor.system_kind) return x11CursorToCss(cursor.system_kind)
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
