"use client"

// Terminal connection state machine — the SSH/Telnet/dbcli analogue of the
// desktop's useDesktopConnection. Turns the coarse connecting→open→closed
// status into a real timed model: a 3-step timeline (建立通道 → 登录主机 →
// 会话就绪) with per-step durations, live elapsed / session clocks, reconnect
// attempt + countdown, link quality from measured ping RTT, and friendly
// disconnect classification (reusing the existing inferDisconnect table).
//
// Generic primitives (linkQuality / formatClock / formatSeconds / LinkQuality)
// are shared with the desktop so a terminal and a desktop read the same scale.

import * as React from "react"
import { inferDisconnect, type DisconnectCategory, type DisconnectSuggestion } from "@/lib/terminal/disconnect-reasons"
import { linkQuality, type LinkQuality } from "@/components/desktop/desktop-connection"
import type { Status } from "./terminal-types"

export type StepKey = "channel" | "auth" | "ready"

interface StepDef {
  key: StepKey
  label: string
  hint: string
}

const STEP_DEFS: readonly StepDef[] = [
  { key: "channel", label: "建立通道", hint: "与网关建立加密 WebSocket 通道" },
  { key: "auth", label: "登录主机", hint: "在远端主机上完成身份认证" },
  { key: "ready", label: "会话就绪", hint: "等待远端 Shell 就绪" },
]
const STEP_KEYS = STEP_DEFS.map((s) => s.key)
const TOTAL_STEPS = STEP_DEFS.length

export interface ConnectionStep {
  key: StepKey
  label: string
  hint: string
  state: "pending" | "active" | "done"
  durationMs: number | null
}

export interface TermError {
  title: string
  detail: string
  category: DisconnectCategory
  suggestion: DisconnectSuggestion
  href?: string
  raw: string
}

const CATEGORY_TITLE: Record<DisconnectCategory, string> = {
  networkUnreachable: "无法连接到主机",
  networkFlap: "网络抖动导致断开",
  authFailed: "登录被远端拒绝",
  serverClosed: "远端关闭了会话",
  timeout: "连接主机超时",
  agentUnavailable: "网域无在线 Agent",
  unknown: "连接已断开",
}

const CATEGORY_DETAIL: Record<DisconnectCategory, string> = {
  networkUnreachable: "主机不可达。确认它在线、端口可达，再重试。",
  networkFlap: "链路短暂中断。多数情况下重连即可恢复。",
  authFailed: "凭据被远端拒绝。核对账号资料里的用户名 / 密码 / 密钥后重试。",
  serverClosed: "远端主动结束了会话（可能是超时或注销）。",
  timeout: "等待远端响应超时。可能是主机繁忙或网络拥塞。",
  agentUnavailable: "该资产经反连 Agent 接入，但其网域当前没有在线的 Agent。请在网域页激活或检查 Agent 后重试。",
  unknown: "连接在中途断开。重试通常可恢复。",
}

export const SUGGESTION_LABEL: Record<DisconnectSuggestion, string> = {
  checkNode: "检查节点",
  checkCredentials: "检查凭据",
  retry: "重试",
  checkAgent: "去网域管理",
  contactAdmin: "联系管理员",
}

export function classifyDisconnect(raw: string): TermError {
  const info = inferDisconnect(raw)
  return {
    title: CATEGORY_TITLE[info.category],
    detail: CATEGORY_DETAIL[info.category],
    category: info.category,
    suggestion: info.suggestion,
    href: info.href,
    raw: info.raw,
  }
}

const LATENCY_HISTORY_CAP = 40
const DURATION_FLOOR_MS = 120

interface CoreState {
  status: Status
  startedAt: number
  connectedAt: number | null
  marks: { key: StepKey; at: number }[]
  error: TermError | null
  attempt: number
  retryAt: number | null
  latencyMs: number | null
  latencyHistory: number[]
}

type Action =
  | { type: "start"; at: number }
  | { type: "mark"; step: StepKey; at: number }
  | { type: "ready"; at: number }
  | { type: "fail"; error: TermError }
  | { type: "close" }
  | { type: "reconnect"; attempt: number; retryAt: number }
  | { type: "latency"; ms: number }

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
    case "start":
      return {
        ...state,
        status: "connecting",
        startedAt: action.at,
        connectedAt: null,
        marks: [],
        error: null,
        attempt: 0,
        retryAt: null,
        latencyMs: null,
        latencyHistory: [],
      }
    case "mark": {
      const target = STEP_KEYS.indexOf(action.step) + 1
      return { ...state, marks: advanceMarks(state.marks, target, action.at) }
    }
    case "ready":
      return {
        ...state,
        status: "open",
        marks: advanceMarks(state.marks, TOTAL_STEPS, action.at),
        connectedAt: state.connectedAt ?? action.at,
        attempt: 0,
        retryAt: null,
        error: null,
      }
    case "fail":
      return { ...state, status: "error", error: action.error, retryAt: null }
    case "close":
      return { ...state, status: "closed", retryAt: null }
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

function isTransient(status: Status): boolean {
  return status === "connecting" || status === "reconnecting"
}

export interface TerminalConnection {
  status: Status
  steps: ConnectionStep[]
  error: TermError | null
  elapsedMs: number
  sessionMs: number | null
  attempt: number
  retryInMs: number | null
  latencyMs: number | null
  latencyHistory: number[]
  quality: LinkQuality
  // actions
  start: () => void
  markOpen: () => void
  markReady: () => void
  fail: (raw: string) => void
  close: () => void
  beginReconnect: (attempt: number, delayMs: number) => void
  pushLatency: (ms: number) => void
}

export function useTerminalConnection(): TerminalConnection {
  const [core, dispatch] = React.useReducer(reducer, undefined, () => ({
    status: "connecting" as Status,
    startedAt: Date.now(),
    connectedAt: null,
    marks: [],
    error: null,
    attempt: 0,
    retryAt: null,
    latencyMs: null,
    latencyHistory: [],
  }))

  const [now, setNow] = React.useState(() => Date.now())
  const counting = core.retryAt != null
  React.useEffect(() => {
    const fast = isTransient(core.status) || counting
    const open = core.status === "open"
    if (!fast && !open) return
    const interval = fast ? 250 : 1000
    const t = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(t)
  }, [core.status, counting])

  const start = React.useCallback(() => dispatch({ type: "start", at: Date.now() }), [])
  const markOpen = React.useCallback(() => dispatch({ type: "mark", step: "channel", at: Date.now() }), [])
  const markReady = React.useCallback(() => dispatch({ type: "ready", at: Date.now() }), [])
  const fail = React.useCallback((raw: string) => dispatch({ type: "fail", error: classifyDisconnect(raw) }), [])
  const close = React.useCallback(() => dispatch({ type: "close" }), [])
  const beginReconnect = React.useCallback(
    (attempt: number, delayMs: number) => dispatch({ type: "reconnect", attempt, retryAt: Date.now() + delayMs }),
    [],
  )
  const pushLatency = React.useCallback((ms: number) => dispatch({ type: "latency", ms }), [])

  const steps = React.useMemo<ConnectionStep[]>(() => {
    const completed = core.marks.length
    return STEP_DEFS.map((def, i) => {
      let state: ConnectionStep["state"]
      if (i < completed || core.status === "open") state = "done"
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

  const elapsedMs = Math.max(0, (core.connectedAt ?? now) - core.startedAt)
  const sessionMs = core.connectedAt != null ? Math.max(0, now - core.connectedAt) : null
  const retryInMs = core.retryAt != null ? Math.max(0, core.retryAt - now) : null
  const quality = React.useMemo(() => linkQuality(core.latencyMs), [core.latencyMs])

  return {
    status: core.status,
    steps,
    error: core.error,
    elapsedMs,
    sessionMs,
    attempt: core.attempt,
    retryInMs,
    latencyMs: core.latencyMs,
    latencyHistory: core.latencyHistory,
    quality,
    start,
    markOpen,
    markReady,
    fail,
    close,
    beginReconnect,
    pushLatency,
  }
}
