"use client"

// Desktop connection state machine. One hook, shared by both the FreeRDP and
// IronRDP shells, that turns the coarse DesktopStatus stream into a real,
// timed connection model: an ordered step timeline with per-step durations,
// live elapsed / session clocks, reconnect attempt + countdown, link quality
// derived from measured RTT, and friendly error classification.
//
// The point of this file is that the connection stage never has to fake
// anything — every percentage, duration, and quality bar traces back to a real
// transition timestamp or a real latency sample.

import * as React from "react"
import type { DesktopStatus } from "./desktop-types"

// ----- Steps -----------------------------------------------------------------

export type StepKey = "prepare" | "session" | "channel" | "handshake" | "frame"

interface StepDef {
  key: StepKey
  label: string
  // One-line plain-language hint shown under the active step. Written for an
  // operator connecting to a Windows host, not for a protocol engineer.
  hint: string
}

// The canonical, ordered connection phases. Order is load-bearing: marks are
// pushed in this sequence and durations are computed against the prior mark.
const STEP_DEFS: readonly StepDef[] = [
  { key: "prepare", label: "准备本地画面", hint: "初始化渲染器与浏览器解码能力" },
  { key: "session", label: "建立远端会话", hint: "向网关申请到目标主机的会话" },
  { key: "channel", label: "打通加密通道", hint: "与网关建立加密数据通道" },
  { key: "handshake", label: "协商桌面会话", hint: "与远端协商安全层与桌面参数" },
  { key: "frame", label: "呈现远端画面", hint: "等待第一帧桌面画面" },
]

const STEP_KEYS = STEP_DEFS.map((s) => s.key)
const TOTAL_STEPS = STEP_DEFS.length

export interface ConnectionStep {
  key: StepKey
  label: string
  hint: string
  state: "pending" | "active" | "done"
  // Wall time spent in this step, filled once the step completes. null while
  // pending/active, or for a step that completed together with its neighbour
  // faster than the render threshold.
  durationMs: number | null
}

// ----- Link quality ----------------------------------------------------------

export type QualityLevel = 0 | 1 | 2 | 3 | 4
export type QualityTone = "muted" | "good" | "fair" | "poor"

export interface LinkQuality {
  level: QualityLevel
  label: string
  tone: QualityTone
}

// linkQuality maps a measured round-trip time to a glanceable signal. Kept
// exported so the toolbar / status bar / stage all read the same scale.
export function linkQuality(latencyMs: number | null): LinkQuality {
  if (latencyMs == null) return { level: 0, label: "测量中", tone: "muted" }
  if (latencyMs <= 50) return { level: 4, label: "流畅", tone: "good" }
  if (latencyMs <= 110) return { level: 3, label: "良好", tone: "good" }
  if (latencyMs <= 220) return { level: 2, label: "一般", tone: "fair" }
  if (latencyMs <= 400) return { level: 1, label: "较差", tone: "poor" }
  return { level: 1, label: "卡顿", tone: "poor" }
}

// ----- Error classification --------------------------------------------------

export type ErrorKind = "security" | "auth" | "network" | "timeout" | "unsupported" | "generic"

export interface ConnError {
  // Human headline — what the operator should understand happened.
  title: string
  // The underlying message, kept for the collapsible "技术详情".
  detail: string
  kind: ErrorKind
  code?: number
  // True when the failure looks like an NLA / transport negotiation problem
  // the "禁用 NLA 重试" shortcut can unblock.
  canForceTls: boolean
}

// 0x0002000D = ERRCONNECT_CONNECT_TRANSPORT_FAILED — TLS/NLA handshake timed
// out. The one code we special-case for a force-TLS retry shortcut.
const ERR_TRANSPORT_FAILED = 0x0002000d

export function classifyError(message: string, code?: number): ConnError {
  const detail = (message || "").trim() || "未知错误"
  const lower = detail.toLowerCase()

  if (code === ERR_TRANSPORT_FAILED || lower.includes("transport")) {
    return {
      title: "安全层协商失败",
      detail,
      kind: "security",
      code,
      canForceTls: true,
    }
  }
  if (
    lower.includes("logon") ||
    lower.includes("credential") ||
    lower.includes("password") ||
    lower.includes("授权") ||
    lower.includes("认证") ||
    lower.includes("登录")
  ) {
    return { title: "凭据被远端拒绝", detail, kind: "auth", code, canForceTls: false }
  }
  if (lower.includes("timeout") || lower.includes("超时") || lower.includes("timed out")) {
    return { title: "连接远端超时", detail, kind: "timeout", code, canForceTls: false }
  }
  if (
    lower.includes("refused") ||
    lower.includes("unreachable") ||
    lower.includes("network") ||
    lower.includes("websocket") ||
    lower.includes("网络") ||
    lower.includes("断开")
  ) {
    return { title: "无法连接到远端", detail, kind: "network", code, canForceTls: false }
  }
  if (lower.includes("unsupported") || lower.includes("不支持") || lower.includes("gateway")) {
    return { title: "后端未就绪", detail, kind: "unsupported", code, canForceTls: false }
  }
  return { title: "连接未能建立", detail, kind: "generic", code, canForceTls: code === ERR_TRANSPORT_FAILED }
}

// ----- Hook ------------------------------------------------------------------

const LATENCY_HISTORY_CAP = 40
// Durations below this read as render noise (steps that completed together);
// the stage hides them rather than print "0.0s".
const DURATION_FLOOR_MS = 120

interface CoreState {
  status: DesktopStatus
  startedAt: number
  connectedAt: number | null
  marks: { key: StepKey; at: number }[]
  error: ConnError | null
  attempt: number
  retryAt: number | null
  latencyMs: number | null
  latencyHistory: number[]
}

type Action =
  | { type: "restart"; at: number }
  | { type: "status"; status: DesktopStatus; at: number }
  | { type: "mark"; step: StepKey; at: number }
  | { type: "fail"; error: ConnError }
  | { type: "reconnect"; attempt: number; retryAt: number }
  | { type: "latency"; ms: number }

// Number of steps a given status implies are complete. -1 means "leave the
// timeline frozen" (reconnecting / closed / error keep whatever was reached).
function completedForStatus(status: DesktopStatus): number {
  switch (status) {
    case "loading-script":
      return 0
    case "connecting":
      return 2 // prepare + session done; channel in flight
    case "handshake":
      return 3 // + channel done; handshake in flight
    case "connected":
      return TOTAL_STEPS
    default:
      return -1
  }
}

function advanceMarks(
  marks: { key: StepKey; at: number }[],
  target: number,
  at: number,
): { key: StepKey; at: number }[] {
  if (target <= marks.length) return marks
  const next = marks.slice()
  while (next.length < target && next.length < TOTAL_STEPS) {
    next.push({ key: STEP_KEYS[next.length], at })
  }
  return next
}

function reducer(state: CoreState, action: Action): CoreState {
  switch (action.type) {
    case "restart":
      return {
        ...state,
        status: "loading-script",
        startedAt: action.at,
        connectedAt: null,
        marks: [],
        error: null,
        retryAt: null,
        latencyMs: null,
        latencyHistory: [],
      }
    case "status": {
      const target = completedForStatus(action.status)
      const marks = target < 0 ? state.marks : advanceMarks(state.marks, target, action.at)
      const connectedAt =
        action.status === "connected" ? state.connectedAt ?? action.at : state.connectedAt
      return {
        ...state,
        status: action.status,
        marks,
        connectedAt,
        // A live status (anything but reconnecting) clears a pending countdown.
        retryAt: action.status === "reconnecting" ? state.retryAt : null,
        // Reaching connected resets the attempt badge and clears any stale error.
        attempt: action.status === "connected" ? 0 : state.attempt,
        error: action.status === "connected" ? null : state.error,
      }
    }
    case "mark": {
      const target = STEP_KEYS.indexOf(action.step) + 1
      return { ...state, marks: advanceMarks(state.marks, target, action.at) }
    }
    case "fail":
      return { ...state, status: "error", error: action.error, retryAt: null }
    case "reconnect":
      return { ...state, status: "reconnecting", attempt: action.attempt, retryAt: action.retryAt }
    case "latency": {
      const history = state.latencyHistory.concat(action.ms)
      if (history.length > LATENCY_HISTORY_CAP) history.splice(0, history.length - LATENCY_HISTORY_CAP)
      return { ...state, latencyMs: action.ms, latencyHistory: history }
    }
    default:
      return state
  }
}

function isTransient(status: DesktopStatus): boolean {
  return (
    status === "loading-script" ||
    status === "connecting" ||
    status === "handshake" ||
    status === "reconnecting"
  )
}

export interface DesktopConnection {
  status: DesktopStatus
  steps: ConnectionStep[]
  error: ConnError | null
  elapsedMs: number
  sessionMs: number | null
  attempt: number
  retryInMs: number | null
  latencyMs: number | null
  latencyHistory: number[]
  quality: LinkQuality
  // actions
  setStatus: (s: DesktopStatus) => void
  mark: (step: StepKey) => void
  fail: (message: string, code?: number) => void
  restart: () => void
  beginReconnect: (attempt: number, delayMs: number) => void
  pushLatency: (ms: number) => void
}

export function useDesktopConnection(): DesktopConnection {
  const [core, dispatch] = React.useReducer(reducer, undefined, () => ({
    status: "loading-script" as DesktopStatus,
    startedAt: Date.now(),
    connectedAt: null,
    marks: [],
    error: null,
    attempt: 0,
    retryAt: null,
    latencyMs: null,
    latencyHistory: [],
  }))

  // Live clock. Ticks fast while a transient phase or a retry countdown is in
  // flight (the elapsed / countdown text moves), slow while connected (only the
  // session timer ticks), and not at all once settled with nothing to count.
  const [now, setNow] = React.useState(() => Date.now())
  const counting = core.retryAt != null
  React.useEffect(() => {
    const fast = isTransient(core.status) || counting
    const connected = core.status === "connected"
    if (!fast && !connected) return
    const interval = fast ? 250 : 1000
    const t = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(t)
  }, [core.status, counting])

  const setStatus = React.useCallback((s: DesktopStatus) => {
    dispatch({ type: "status", status: s, at: Date.now() })
  }, [])
  const mark = React.useCallback((step: StepKey) => {
    dispatch({ type: "mark", step, at: Date.now() })
  }, [])
  const fail = React.useCallback((message: string, code?: number) => {
    dispatch({ type: "fail", error: classifyError(message, code) })
  }, [])
  const restart = React.useCallback(() => {
    dispatch({ type: "restart", at: Date.now() })
  }, [])
  const beginReconnect = React.useCallback((attempt: number, delayMs: number) => {
    dispatch({ type: "reconnect", attempt, retryAt: Date.now() + delayMs })
  }, [])
  const pushLatency = React.useCallback((ms: number) => {
    dispatch({ type: "latency", ms })
  }, [])

  const steps = React.useMemo<ConnectionStep[]>(() => {
    const completed = core.marks.length
    return STEP_DEFS.map((def, i) => {
      let state: ConnectionStep["state"]
      if (i < completed || core.status === "connected") state = "done"
      else if (i === completed && isTransient(core.status)) state = "active"
      else state = "pending"
      let durationMs: number | null = null
      if (i < core.marks.length) {
        const start = i === 0 ? core.startedAt : core.marks[i - 1].at
        const d = Math.max(0, core.marks[i].at - start)
        durationMs = d >= DURATION_FLOOR_MS ? d : null
      }
      return { key: def.key, label: def.label, hint: def.hint, state, durationMs }
    })
  }, [core.marks, core.status, core.startedAt])

  const elapsedMs = (core.connectedAt ?? now) - core.startedAt
  const sessionMs = core.connectedAt != null ? Math.max(0, now - core.connectedAt) : null
  const retryInMs = core.retryAt != null ? Math.max(0, core.retryAt - now) : null
  const quality = React.useMemo(() => linkQuality(core.latencyMs), [core.latencyMs])

  return {
    status: core.status,
    steps,
    error: core.error,
    elapsedMs: Math.max(0, elapsedMs),
    sessionMs,
    attempt: core.attempt,
    retryInMs,
    latencyMs: core.latencyMs,
    latencyHistory: core.latencyHistory,
    quality,
    setStatus,
    mark,
    fail,
    restart,
    beginReconnect,
    pushLatency,
  }
}

// formatClock renders an elapsed millisecond span as a human session clock:
// "0:42" under an hour, "1:03:20" past it. Used by the session timer.
export function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

// formatSeconds renders a short elapsed span as "1.2s" / "320ms" for the
// connection timeline. Sub-second durations read in ms so a fast handshake
// doesn't collapse to "0.0s".
export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
