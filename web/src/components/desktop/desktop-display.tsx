"use client"

// DesktopDisplay v2 — top-level React component for the workspace-v2
// `rdp_next` protocol. Mounts a canvas renderer, opens the WS data channel
// via FrameClient, attaches keyboard/mouse handlers, and coordinates a
// shadcn-styled toolbar + status bar + settings drawer + command palette +
// context menu. Mirrors the WebSSHTerminal v2 layout for a consistent
// workspace experience across protocols.

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "@/components/ui/sonner"
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
import { WebRTCVideoClient } from "@/lib/desktop/webrtc-video"
import { DesktopAudioPlayer } from "@/lib/desktop/audio-player"
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
import { PortalContainerProvider } from "@/components/ui/portal-container"
import { SessionWatermark } from "@/components/watermark/session-watermark"
import { DesktopCommandPalette } from "./desktop-command-palette"
import { DesktopContextMenu } from "./desktop-context-menu"
import { DesktopConnectionStage } from "./desktop-connection-stage"
import { useDesktopConnection } from "./desktop-connection"
import { DesktopPerfPanel } from "./desktop-perf-panel"
import { DesktopSettingsSheet } from "./desktop-settings-sheet"
import { DesktopFilePanel } from "./desktop-file-panel"
import { DesktopToolbar } from "./desktop-toolbar"
import { IronRdpDesktopShell } from "./desktop-display-iron"
import { bitmapCursorCss, rawBgraCursorCss, x11CursorToCss } from "./desktop-cursor-map"
import { expandCombo, keysymForEvent, scancodeForCode } from "./desktop-key-map"
import { useDesktopSettings, effectiveDpiScale } from "./use-desktop-settings"
import { useDesktopChrome } from "./use-desktop-chrome"
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
  const reduceMotion = useReducedMotion()

  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  // Hidden editable sink the OS input method composes into. Keyboard events
  // ride window listeners (so they fire regardless of focus), but IME
  // composition events only fire on a focused editable element — this textarea
  // is it. carries data-desktop-passthrough so keysymForEvent still forwards
  // real keys while it's focused.
  const imeSinkRef = React.useRef<HTMLTextAreaElement | null>(null)
  const rendererRef = React.useRef<CanvasRendererHandle | null>(null)
  const clientRef = React.useRef<FrameClient | null>(null)
  const webrtcRef = React.useRef<WebRTCVideoClient | null>(null)
  const audioPlayerRef = React.useRef<DesktopAudioPlayer | null>(null)
  const sessionIdRef = React.useRef<string>("")
  const reconnectAttemptRef = React.useRef(0)
  const sessionEpochRef = React.useRef(0)
  // Set once WebRTC negotiation fails so reconnects within this mount take the
  // proven GFX bitmap path instead of stalling on a broken peer connection
  // again. Reset on a manual reconnect (the effect re-runs on bumpKey).
  const webrtcFailedRef = React.useRef(false)
  // Tracks the last applied video transport/quality so a change to either can
  // trigger a reconnect (the codec / GFX choice is fixed at connect time).
  const videoCfgRef = React.useRef({ t: "", q: "", d: "" })
  const detachInputsRef = React.useRef<(() => void) | null>(null)
  const lastCursorRef = React.useRef<CursorUpdate | null>(null)

  // Connection state machine — owns status, the timed step timeline, reconnect
  // countdown, link quality and error classification. `setStatus`/`fail`/`mark`
  // etc. are stable callbacks safe to call from the long-lived connect effect.
  const conn = useDesktopConnection()
  const status = conn.status
  const setStatus = conn.setStatus
  const [fullscreen, setFullscreen] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [perfOpen, setPerfOpen] = React.useState(false)
  const [filesOpen, setFilesOpen] = React.useState(false)
  const [remote, setRemote] = React.useState({ w: 1280, h: 720 })
  // Pointer coords feed nothing visible now (the old status bar showed them);
  // kept as a setter the input bridge can call without tracking the value.
  const [, setPointer] = React.useState({ x: 0, y: 0 })
  // True once the WebRTC <video> track is playing. Shows the GPU-decoded video
  // over the canvas; cleared on fallback so the canvas/FrameClient path shows.
  const [videoActive, setVideoActive] = React.useState(false)
  const [stats, setStats] = React.useState<SessionStats>({
    bytesIn: 0,
    bytesOut: 0,
    latencyMs: null,
    fps: null,
  })
  const [pasteConfirm, setPasteConfirm] = React.useState<string | null>(null)
  const [bumpKey, setBumpKey] = React.useState(0)

  // Single auto-hiding control bar (shared with the IronRDP shell). Owns the
  // wrapper element (for the Fullscreen API + portal target) and the show/hide
  // state machine.
  const anyOverlayOpen = settingsOpen || filesOpen || paletteOpen || perfOpen
  // Only auto-hide once connected — while connecting / reconnecting / errored the
  // bar stays pinned so its status + reconnect controls are always reachable.
  const { wrapRef, wrapEl, setWrap, chromeShown, revealChrome, onBarMouseEnter, onBarMouseLeave } =
    useDesktopChrome(fullscreen && status === "connected", anyOverlayOpen)

  // Settings live in a ref so the WS connect effect (which depends on
  // nodeId / backend / bumpKey) doesn't re-fire on every checkbox toggle.
  const settingsRef = React.useRef(settings)
  React.useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // Dynamic resolution: when enabled, push the live viewport size to the worker
  // as the stage resizes so the remote desktop reflows at native 1:1 (RDPEDISP),
  // no scaling blur. Debounced so a window drag doesn't flood the channel. This
  // only takes effect when the node also enabled rdp.dynamic_resolution (the
  // worker brings up the disp channel + acts on resize then); otherwise the
  // worker just records the size for the next reconnect — a harmless no-op here.
  React.useEffect(() => {
    if (!settings.dynamicResolution) return
    const host = hostRef.current
    if (typeof ResizeObserver === "undefined" || !host) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastW = 0
    let lastH = 0
    const send = () => {
      const client = clientRef.current
      if (!client) return
      const scale = effectiveDpiScale(settingsRef.current)
      // Physical pixels = CSS size × scale/100 (matches the connect-time physical
      // resolution), snapped even + clamped to RDPEDISP's [200, 8192] range.
      let w = Math.max(200, Math.min(8192, Math.round((host.clientWidth * scale) / 100))) & ~1
      let h = Math.max(200, Math.min(8192, Math.round((host.clientHeight * scale) / 100))) & ~1
      if (w < 200) w = 200
      if (h < 200) h = 200
      if (w === lastW && h === lastH) return
      lastW = w
      lastH = h
      client.send({ resize: { width: w, height: h } })
    }
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(send, 350)
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [settings.dynamicResolution])

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

    reconnectAttemptRef.current = 0
    webrtcFailedRef.current = false // fresh mount / manual reconnect retries WebRTC

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
    detachRendererMetrics = renderer.onMetrics(({ avgDecodeMs, avgPaintMs, framesPainted, droppedFrames, codec, decoderPath, renderSurface }) => {
      if (cancelled) return
      setStats((prev) => ({
        ...prev,
        fps: framesPainted,
        avgDecodeMs,
        avgPaintMs,
        droppedFrames,
        codec,
        decoderPath,
        renderSurface,
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
      webrtcRef.current?.close()
      webrtcRef.current = null
      if (!cancelled) setVideoActive(false)
      clientRef.current?.close()
      clientRef.current = null
      audioPlayerRef.current?.close()
      audioPlayerRef.current = null
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
        conn.fail("多次重连失败,请检查网络或手动重试")
        return
      }
      const delay = RECONNECT_BACKOFFS_MS[attempt]
      reconnectAttemptRef.current = attempt + 1
      // Surface the attempt + countdown on the stage so the user sees a live
      // "Xs 后重试 / 立即重试" instead of a frozen spinner.
      conn.beginReconnect(attempt + 1, delay)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        if (!isCurrentSession()) return
        connect().catch((e) => {
          if (!isCurrentSession()) return
          conn.fail((e as Error).message)
        })
      }, delay)
    }

    async function connect() {
      if (!isCurrentSession()) return
      closeCurrentSession(true)
      // Fresh attempt: reset the timeline + clocks (keeps the reconnect attempt
      // badge). Covers both the initial mount and reconnect, which calls
      // connect() directly without re-running the effect.
      conn.restart()
      // Probe the browser's decoder support before posting the session
      // start so the gateway can suppress GFX/H.264 on browsers that
      // can't render it. `collectClientCapabilities` is async but fast
      // (~10 ms on Chromium, single-frame round-trip on Safari).
      const clientCaps = await collectClientCapabilities()
      // After a WebRTC failure this mount sticks to the GFX bitmap path so a
      // broken peer connection doesn't stall every reconnect.
      if (webrtcFailedRef.current) clientCaps.webrtc = false
      if (!isCurrentSession()) return
      conn.mark("prepare") // renderer + decoder probe done
      const start = await desktopControl.startSession({
        node_id: nodeId,
        width: settingsRef.current.preferredWidth,
        height: settingsRef.current.preferredHeight,
        dpi: 96,
        // High-DPI scale (percent). The gateway multiplies width/height by it to
        // get the physical render resolution and tells the worker to apply
        // matching Windows display scaling, so HiDPI screens render crisply.
        scale: effectiveDpiScale(settingsRef.current),
        quality: "auto",
        backend,
        client_caps: clientCaps,
        video_transport: settingsRef.current.videoTransport,
        video_quality: settingsRef.current.videoQuality,
      })
      if (!isCurrentSession()) {
        desktopControl.endSession(start.session_id).catch(() => {})
        return
      }
      sessionIdRef.current = start.session_id
      conn.mark("session") // gateway accepted the session

      // WebRTC video path: when the gateway started the session in a WebRTC
      // codec (vp8/vp9/av1) it streams the desktop over a Pion track. We render it
      // in the <video> overlay (GPU decode) and fall back to the canvas/FrameClient
      // bitmap path if negotiation fails. videoMode carries the codec.
      const videoMode = start.video_mode || ""
      const webrtcOn = videoMode === "vp8" || videoMode === "vp9" || videoMode === "av1"
      const iceServers = start.ice_servers || []
      // Surface the active transport in the status bar immediately; onConnected
      // upgrades the WebRTC label once the track is actually playing.
      setStats((prev) => ({ ...prev, transport: webrtcOn ? "WebRTC…" : "JS 位图" }))

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

      // Stand up the WebRTC peer connection once the WS is open (signaling
      // needs an open socket). On any failure, switch the worker back to the WS
      // bitmap path and reveal the canvas — the session keeps running.
      function startWebRTC() {
        if (!isCurrentSession()) return
        const video = videoRef.current
        const client = clientRef.current
        if (!video || !client) return
        webrtcRef.current?.close()
        const rtc = new WebRTCVideoClient({
          video,
          iceServers,
          send: (sig) => client.send({ webrtc: sig }),
          onConnected: () => {
            if (!isCurrentSession()) return
            setVideoActive(true)
            setStats((prev) => ({ ...prev, transport: `WebRTC · ${videoMode.toUpperCase()}` }))
          },
          onFailed: () => {
            if (!isCurrentSession()) return
            // "webrtc" forced → keep retrying WebRTC on reconnect; "auto" →
            // stick to the proven bitmap path so we don't stall every reconnect.
            if (settingsRef.current.videoTransport !== "webrtc") {
              webrtcFailedRef.current = true
            }
            setVideoActive(false)
            setStats((prev) => ({ ...prev, transport: "JS 位图" }))
            // Tell the worker to resume WS bitmap frames; the canvas renders them.
            clientRef.current?.send({ video_mode: "bitmap" })
            webrtcRef.current?.close()
            webrtcRef.current = null
          },
        })
        webrtcRef.current = rtc
        void rtc.start()
      }

      const client = new FrameClient({
        sessionId: start.session_id,
        onOpen: () => {
          conn.mark("channel") // WS data channel established
          if (webrtcOn) startWebRTC()
        },
        onWebRTC: (sig) => {
          void webrtcRef.current?.handleSignal(sig)
        },
        onFrame: (frame) => renderer.paintFrame(frame),
        onFrameBytes: (frame, payload) => renderer.paintFrameBytes(frame, payload),
        onFrameBatch: (frames) => renderer.paintFrameBatchBytes(frames),
        onCursor: (cursor) => renderer.emitCursor(cursor),
        onStatus: (s: SessionStatus) => {
          if (!isCurrentSession()) return
          const next = phaseToStatus(s.phase)
          if (next === "error") {
            conn.fail(s.message || "未知错误", s.code)
            toast.error(s.message || "桌面会话错误")
            return
          }
          conn.setStatus(next)
          if (next === "connected") reconnectAttemptRef.current = 0
          if (next === "closed") scheduleReconnect()
        },
        onError: (msg) => {
          if (!isCurrentSession()) return
          if (settingsRef.current.reconnectOnDrop) {
            scheduleReconnect()
            return
          }
          conn.fail(msg)
        },
        onStats: (s) => {
          if (!isCurrentSession()) return
          setStats((prev) => ({ ...prev, bytesIn: s.bytesIn, bytesOut: s.bytesOut }))
        },
        onLatency: (ms) => {
          if (!isCurrentSession()) return
          conn.pushLatency(ms)
          setStats((prev) => ({ ...prev, latencyMs: ms }))
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
        onAudio: (data) => {
          if (!isCurrentSession()) return
          if (!settingsRef.current.audioPlayback) return
          if (!audioPlayerRef.current) audioPlayerRef.current = new DesktopAudioPlayer()
          audioPlayerRef.current.push(data)
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

      detachInputsRef.current = attachInputs(host, renderer.canvas, client, () => settingsRef.current, setPointer, imeSinkRef.current)

      // Stitch the cleanup helpers into the same teardown closure.
      const detach = detachInputsRef.current
      detachInputsRef.current = () => {
        host.removeEventListener("paste", onPaste)
        detach?.()
      }
    }

    connect().catch((e) => {
      if (!isCurrentSession()) return
      conn.fail((e as Error).message || "无法建立桌面会话")
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
      client.send({ key: { scancode: f.scancode, extended: f.extended, pressed: f.pressed } })
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
    webrtcRef.current?.close()
    webrtcRef.current = null
    setVideoActive(false)
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

  // Changing the video transport or quality reconnects to apply it — the codec
  // and GFX pipeline choice are fixed at connect time. The ref skips the first
  // run (initial mount already connects with the current settings).
  React.useEffect(() => {
    const prev = videoCfgRef.current
    const next = {
      t: settings.videoTransport,
      q: settings.videoQuality,
      // High-DPI changes the negotiated resolution, fixed at connect time, so a
      // change here reconnects too.
      d: `${settings.highDpi ? settings.dpiScale : "off"}`,
    }
    if (prev.t === "" && prev.q === "" && prev.d === "") {
      videoCfgRef.current = next // record initial; don't reconnect on mount
      return
    }
    if (prev.t === next.t && prev.q === next.q && prev.d === next.d) return
    videoCfgRef.current = next
    handleReconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.videoTransport, settings.videoQuality, settings.highDpi, settings.dpiScale])

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={setWrap}
        onMouseMove={fullscreen ? revealChrome : undefined}
        className={cn(
          "relative flex flex-col h-full w-full bg-background isolate",
          fullscreen && "fixed inset-0 z-[60]",
        )}
      >
        <SessionWatermark targetRef={wrapRef} />
        <PortalContainerProvider value={fullscreen ? wrapEl : undefined}>
        {/* Single control bar. In fullscreen it overlays the canvas and slides
            away when idle; in windowed mode it's pinned in normal flow. */}
        <motion.div
          className={cn(fullscreen ? "absolute inset-x-0 top-0 z-[70] p-2.5" : "relative z-10 shrink-0")}
          initial={false}
          animate={{ y: chromeShown ? 0 : "-100%", opacity: chromeShown ? 1 : 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
          style={{ pointerEvents: chromeShown ? "auto" : "none" }}
          onMouseEnter={onBarMouseEnter}
          onMouseLeave={onBarMouseLeave}
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
            backendLabel={backend === "dummy" ? "Dummy" : "FreeRDP"}
            quality={conn.quality}
            stats={stats}
            sessionMs={conn.sessionMs}
            latencyHistory={conn.latencyHistory}
            keyboardLayout={settings.keyboardLayout}
            onOpenPerfPanel={() => setPerfOpen(true)}
            onSendCombo={sendCombo}
            onSendCtrlAltDel={() => sendCombo("Control+Alt+Delete")}
            onFiles={() => setFilesOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onPalette={() => setPaletteOpen(true)}
            onFullscreen={toggleFullscreen}
            onReconnect={handleReconnect}
            onDisconnect={handleDisconnect}
          />
        </motion.div>

        {/* Top reveal strip — in fullscreen, nudging the pointer to the very top
            brings the auto-hidden bar back even without a wider mouse move. */}
        {fullscreen && !chromeShown && (
          <div
            className="absolute inset-x-0 top-0 z-[69] h-2.5"
            onMouseEnter={revealChrome}
            aria-hidden
          />
        )}

        <DesktopContextMenu
          connected={status === "connected"}
          onSendCombo={sendCombo}
          onFullscreen={toggleFullscreen}
          onSettings={() => setSettingsOpen(true)}
          onPalette={() => setPaletteOpen(true)}
          onReconnect={handleReconnect}
          onDisconnect={handleDisconnect}
        >
          <div className={cn("desktop-stage relative flex-1 min-h-0", scaleContainerClass(settings.scaleMode))}>
            <div
              ref={hostRef}
              className={cn("absolute inset-0 flex", scaleHostClass(settings.scaleMode))}
              tabIndex={0}
            />
            {/* WebRTC video overlay. object-contain matches the canvas's
               letterbox geometry (same aspect), so the host's input mapping
               still lines up; pointer-events-none lets mouse/keys reach it. */}
            <video
              ref={videoRef}
              className={cn(
                "pointer-events-none absolute inset-0 h-full w-full bg-black",
                settings.scaleMode === "stretch" ? "object-fill" : "object-contain",
                videoActive ? "" : "hidden",
              )}
              playsInline
              muted
              autoPlay
              tabIndex={-1}
            />
            {/* IME sink: the OS input method composes here. Invisible
               (opacity-0) and click-through (pointer-events-none); moved to the
               last click so the candidate window pops near the cursor. The
               data-desktop-passthrough flag keeps keysymForEvent forwarding real
               keys while it holds focus. */}
            <textarea
              ref={imeSinkRef}
              data-desktop-passthrough
              aria-hidden
              tabIndex={-1}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="pointer-events-none absolute z-10 h-5 w-40 resize-none overflow-hidden border-0 bg-transparent p-0 opacity-0 outline-none"
              style={{ left: 0, top: 0, color: "transparent", caretColor: "transparent" }}
            />
            <DesktopConnectionStage
              conn={conn}
              nodeName={nodeName}
              nodeHost={nodeHost}
              nodePort={nodePort}
              backendLabel={backend === "dummy" ? "Dummy" : "FreeRDP"}
              onRetry={handleReconnect}
              onRetryNow={handleReconnect}
              onForceTlsOnly={handleForceTlsOnly}
              onSwitchToGuacamole={handleSwitchToGuacamole}
              onDisconnect={handleDisconnect}
            />
          </div>
        </DesktopContextMenu>

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

        <DesktopFilePanel open={filesOpen} onOpenChange={setFilesOpen} />

        <DesktopCommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          actions={{
            onSendCombo: sendCombo,
            onFullscreen: toggleFullscreen,
            onFiles: () => setFilesOpen(true),
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
        </PortalContainerProvider>
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
  imeSink: HTMLTextAreaElement | null,
): () => void {
  let pressedButtons = 0
  // IME state. While the OS input method is composing, raw keydowns are
  // suppressed (keysymForEvent returns 0 for isComposing / keyCode 229); the
  // committed string arrives via compositionend and is sent as ClientMessage
  // .text. suppressKeyup eats the single keyup of the commit key (Space/Enter/
  // digit) that fires after compositionend with isComposing already false —
  // otherwise a stray keyup would leak to the remote after the text.
  let suppressKeyup = false

  function focusIme() {
    imeSink?.focus({ preventScroll: true })
  }
  // Keep the candidate window near where the user is working: move the sink to
  // the last click (its caret is what the IME anchors the popup to).
  function moveImeTo(clientX: number, clientY: number) {
    if (!imeSink) return
    const rect = host.getBoundingClientRect()
    imeSink.style.left = `${Math.round(clientX - rect.left)}px`
    imeSink.style.top = `${Math.round(clientY - rect.top)}px`
  }

  function toRemote(e: { clientX: number; clientY: number }): { x: number; y: number } {
    // Map against the CANVAS's on-screen rect, not the host container. The
    // canvas is centered/letterboxed inside the host (maxWidth/maxHeight:100%,
    // no object-fit), so in fit/center/actual modes its painted box is offset
    // from and usually smaller than the host. Using the host rect made clicks
    // drift further off-target toward the bottom-right. canvas.width/height are
    // the remote pixel dimensions; getBoundingClientRect() is the displayed box.
    const rect = canvas.getBoundingClientRect()
    const rw = canvas.width || rect.width || 1
    const rh = canvas.height || rect.height || 1
    const sx = rect.width > 0 ? rw / rect.width : 1
    const sy = rect.height > 0 ? rh / rect.height : 1
    const x = Math.round((e.clientX - rect.left) * sx)
    const y = Math.round((e.clientY - rect.top) * sy)
    // Clamp into remote bounds so clicks in the letterbox margin land on the
    // nearest edge instead of negative / overflow coordinates.
    return {
      x: Math.max(0, Math.min(rw - 1, x)),
      y: Math.max(0, Math.min(rh - 1, y)),
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
    // Anchor + focus the IME sink at the click so the candidate window appears
    // here and composition events fire (the sink must hold focus). Programmatic
    // focus survives the preventDefault below.
    moveImeTo(e.clientX, e.clientY)
    focusIme()
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

  // Scancodes held down on the remote, so we can release them if focus leaves
  // (Alt+Tab / tab switch) and the keyup never arrives — otherwise a modifier
  // stays stuck "down" and the keyboard becomes unusable. Packed: scancode |
  // (extended ? 0x100 : 0).
  const heldScancodes = new Set<number>()

  // Whether this key event should reach the remote at all: skip while an IME is
  // composing (the committed text comes via compositionend) and skip when the
  // user is typing into a real dialog input. The IME sink itself is always
  // allowed (compared by reference, so it works even if the passthrough
  // attribute didn't render — otherwise focusing the sink would swallow every
  // key and the keyboard would go dead).
  function shouldForwardKey(e: KeyboardEvent): boolean {
    if (e.isComposing || e.key === "Process" || e.keyCode === 229) return false
    const active = document.activeElement
    if (
      active &&
      active !== imeSink &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        (active as HTMLElement).isContentEditable) &&
      !(active as HTMLElement).hasAttribute("data-desktop-passthrough")
    ) {
      return false
    }
    return true
  }

  // Send a physical key as an RDP scancode (composes with modifiers → shortcuts
  // work). Falls back to the keysym/Unicode path for keys without a scancode
  // mapping. Down/up stay symmetric (same scancode) so nothing gets stuck.
  function sendKey(e: KeyboardEvent, pressed: boolean) {
    const scan = scancodeForCode(e.code)
    if (scan) {
      const packed = scan.scancode | (scan.extended ? 0x100 : 0)
      if (pressed) heldScancodes.add(packed)
      else heldScancodes.delete(packed)
      // keysym is carried only for the audit timeline (the worker ignores it
      // when a scancode is present) so recorded keystrokes stay human-readable.
      const ks = keysymForEvent(e, { activeElement: document.activeElement })
      client.send({
        key: { scancode: scan.scancode, extended: scan.extended, keysym: ks > 0 ? ks : undefined, pressed },
      } satisfies ClientMessage)
      e.preventDefault()
      return
    }
    const ks = keysymForEvent(e, { activeElement: document.activeElement })
    if (ks > 0) {
      client.send({ key: { keysym: ks, pressed } } satisfies ClientMessage)
      e.preventDefault()
    }
  }

  function releaseHeldKeys() {
    for (const packed of heldScancodes) {
      client.send({ key: { scancode: packed & 0xff, extended: (packed & 0x100) !== 0, pressed: false } })
    }
    heldScancodes.clear()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    suppressKeyup = false // a real keydown means we're past any IME commit
    if (!shouldForwardKey(e)) return
    sendKey(e, true)
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (suppressKeyup) {
      suppressKeyup = false
      e.preventDefault()
      return
    }
    if (!shouldForwardKey(e)) return
    sendKey(e, false)
  }
  // Releasing held keys on focus loss is what keeps modifiers from sticking.
  const onWindowBlur = () => releaseHeldKeys()
  const onVisibility = () => {
    if (document.visibilityState === "hidden") releaseHeldKeys()
  }

  // IME composition: the committed phrase ("你好") arrives here, not as keydowns.
  const onCompositionEnd = (e: CompositionEvent) => {
    const text = e.data
    if (imeSink) imeSink.value = "" // keep the sink empty for the next round
    suppressKeyup = true // eat the commit key's trailing keyup
    if (text) client.send({ text } satisfies ClientMessage)
  }

  host.addEventListener("mousemove", onMove)
  host.addEventListener("mousedown", onDown)
  host.addEventListener("mouseup", onUp)
  host.addEventListener("wheel", onWheel, { passive: false })
  host.addEventListener("contextmenu", onContext)
  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("keyup", onKeyUp)
  window.addEventListener("blur", onWindowBlur)
  document.addEventListener("visibilitychange", onVisibility)
  imeSink?.addEventListener("compositionend", onCompositionEnd)
  // Focus the sink up front so the input method works before the first click.
  focusIme()

  return () => {
    releaseHeldKeys()
    host.removeEventListener("mousemove", onMove)
    host.removeEventListener("mousedown", onDown)
    host.removeEventListener("mouseup", onUp)
    host.removeEventListener("wheel", onWheel)
    host.removeEventListener("contextmenu", onContext)
    window.removeEventListener("keydown", onKeyDown)
    window.removeEventListener("keyup", onKeyUp)
    window.removeEventListener("blur", onWindowBlur)
    document.removeEventListener("visibilitychange", onVisibility)
    imeSink?.removeEventListener("compositionend", onCompositionEnd)
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
