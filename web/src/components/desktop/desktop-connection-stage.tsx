"use client"

// The connection stage — a full-bleed dark "boot screen" that owns the canvas
// area until the remote desktop is live. The node is the protagonist (serif
// name, large), the connection progress is a real timed stepper, and every
// failure resolves to a calm recovery panel rather than a hex dump. Replaces
// the old centred shadcn loading card.

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Check,
  ChevronDown,
  Loader2,
  Plug,
  RotateCw,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { SignalBars } from "./desktop-signal"
import { formatSeconds, type ConnError, type DesktopConnection } from "./desktop-connection"

// Fixed warm-dark palette. The stage always sits over the black canvas, so it
// reads off the theme tokens (which would turn to ink in light mode) and uses
// explicit on-dark values instead.
const C = {
  text: "#f5f1ea",
  textSoft: "#a8a39a",
  textFaint: "#6f6b63",
  hair: "rgba(245,241,234,0.10)",
  coral: "#cc785c",
  good: "#5db872",
  amber: "#e8a55a",
  red: "#e0664c",
}

const EASE = [0.22, 1, 0.36, 1] as const

type Props = {
  conn: DesktopConnection
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  backendLabel?: string
  onRetry: () => void
  onRetryNow?: () => void
  onForceTlsOnly?: () => void
  onSwitchToGuacamole?: () => void
  onDisconnect?: () => void
}

export function DesktopConnectionStage({
  conn,
  nodeName,
  nodeHost,
  nodePort,
  backendLabel,
  onRetry,
  onRetryNow,
  onForceTlsOnly,
  onSwitchToGuacamole,
  onDisconnect,
}: Props) {
  const reduce = useReducedMotion()
  const { status } = conn
  if (status === "connected") return null

  const isError = status === "error"
  const isClosed = status === "closed"
  const isReconnecting = status === "reconnecting"
  const eyebrow = isError
    ? "接入失败"
    : isClosed
      ? "会话已结束"
      : isReconnecting
        ? "连接已中断"
        : conn.attempt > 0
          ? "正在重连"
          : "接入中"

  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden"
      style={{
        background:
          "radial-gradient(120% 100% at 50% -10%, #20201c 0%, #18171400 60%), linear-gradient(180deg, #161512 0%, #121110 100%)",
        color: C.text,
      }}
      role="status"
      aria-live="polite"
    >
      {/* Ambient coral glow behind the node name — gentle breathing, off under
          reduced motion. Tinted by state so a failure cools to red. */}
      {!reduce && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[30%] h-[340px] w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[80px]"
          style={{
            background: isError ? "rgba(224,102,76,0.16)" : "rgba(204,120,92,0.16)",
          }}
          animate={{ opacity: [0.5, 0.85, 0.5], scale: [0.94, 1.06, 0.94] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}

      <motion.div
        initial={reduce ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
        className="relative w-full max-w-[26rem] px-8"
      >
        {/* ---- Header: node identity, always present ---- */}
        <div className="flex flex-col items-center text-center">
          <motion.span
            key={eyebrow}
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="eyebrow"
            style={{ color: isError ? C.red : C.coral }}
          >
            {eyebrow}
          </motion.span>
          <h2
            className="display-title mt-2 max-w-full truncate text-[2rem] leading-tight"
            style={{ color: C.text }}
            title={nodeName}
          >
            {nodeName || "远端桌面"}
          </h2>
          <div
            className="mt-1.5 flex items-center gap-2 font-mono text-[12px]"
            style={{ color: C.textSoft }}
          >
            {nodeHost ? (
              <span className="truncate">
                {nodeHost}
                {nodePort ? `:${nodePort}` : ""}
              </span>
            ) : null}
            {backendLabel && (
              <>
                {nodeHost && <Dot />}
                <span className="uppercase tracking-wide" style={{ color: C.textFaint }}>
                  {backendLabel}
                </span>
              </>
            )}
          </div>
        </div>

        {/* ---- Body: varies by state ---- */}
        <div className="mt-7">
          <AnimatePresence mode="wait">
            {isError ? (
              <ErrorPanel
                key="error"
                error={conn.error}
                reduce={!!reduce}
                onRetry={onRetry}
                onForceTlsOnly={onForceTlsOnly}
                onSwitchToGuacamole={onSwitchToGuacamole}
              />
            ) : isClosed ? (
              <ClosedPanel key="closed" reduce={!!reduce} onRetry={onRetry} />
            ) : isReconnecting ? (
              <ReconnectPanel
                key="reconnecting"
                attempt={conn.attempt}
                retryInMs={conn.retryInMs}
                reduce={!!reduce}
                onRetryNow={onRetryNow ?? onRetry}
                onDisconnect={onDisconnect}
              />
            ) : (
              <ConnectingPanel key="connecting" conn={conn} reduce={!!reduce} />
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}

// ----- Connecting: the live timed stepper ------------------------------------

function ConnectingPanel({ conn, reduce }: { conn: DesktopConnection; reduce: boolean }) {
  const { steps, latencyMs, quality } = conn
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduce ? undefined : { opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <ol className="relative">
        {steps.map((step, i) => {
          const last = i === steps.length - 1
          const lineActive = step.state === "done"
          return (
            <motion.li
              key={step.key}
              initial={reduce ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, ease: EASE, delay: reduce ? 0 : i * 0.05 }}
              className="relative flex gap-3 pb-3.5 last:pb-0"
            >
              {/* connector spine */}
              {!last && (
                <span
                  className="absolute left-[8.5px] top-[20px] bottom-0 w-px"
                  style={{ background: lineActive ? C.good : C.hair }}
                />
              )}
              <StepDot state={step.state} />
              <div className="min-w-0 flex-1 pt-px">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className="text-[13px]"
                    style={{
                      color:
                        step.state === "pending"
                          ? C.textFaint
                          : step.state === "active"
                            ? C.text
                            : C.textSoft,
                      fontWeight: step.state === "active" ? 500 : 400,
                    }}
                  >
                    {step.label}
                  </span>
                  {step.durationMs != null && (
                    <span className="shrink-0 font-mono text-[11px]" style={{ color: C.textFaint }}>
                      {formatSeconds(step.durationMs)}
                    </span>
                  )}
                </div>
                {/* The active step gets a one-line plain-language hint. */}
                <AnimatePresence>
                  {step.state === "active" && (
                    <motion.p
                      initial={reduce ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={reduce ? undefined : { opacity: 0, height: 0 }}
                      transition={{ duration: 0.25, ease: EASE }}
                      className="overflow-hidden text-[11.5px] leading-relaxed"
                      style={{ color: C.textFaint }}
                    >
                      {step.hint}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            </motion.li>
          )
        })}
      </ol>

      {/* elapsed + link quality strip */}
      <div
        className="mt-5 flex items-center justify-between border-t pt-3.5"
        style={{ borderColor: C.hair }}
      >
        <span className="font-mono text-[11px]" style={{ color: C.textFaint }}>
          已用时 {formatSeconds(conn.elapsedMs)}
        </span>
        <span className="flex items-center gap-2 text-[11.5px]" style={{ color: C.textSoft }}>
          <span style={{ color: C.textFaint }}>
            <SignalBars level={quality.level} tone={quality.tone} />
          </span>
          {latencyMs != null ? (
            <span>
              {quality.label} · <span className="font-mono">{latencyMs}ms</span>
            </span>
          ) : (
            <span style={{ color: C.textFaint }}>链路测量中</span>
          )}
        </span>
      </div>
    </motion.div>
  )
}

function StepDot({ state }: { state: "pending" | "active" | "done" }) {
  if (state === "done") {
    return (
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 22 }}
        className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
        style={{ background: C.good }}
      >
        <Check className="h-3 w-3" strokeWidth={3} style={{ color: "#10231a" }} />
      </motion.span>
    )
  }
  if (state === "active") {
    return (
      <span className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <Loader2 className="h-[18px] w-[18px] animate-spin" style={{ color: C.coral }} strokeWidth={2.5} />
      </span>
    )
  }
  return (
    <span
      className="relative z-10 mt-px h-[16px] w-[16px] shrink-0 rounded-full border"
      style={{ borderColor: C.hair, background: "#1a1916" }}
    />
  )
}

// ----- Reconnecting: countdown + instant retry -------------------------------

function ReconnectPanel({
  attempt,
  retryInMs,
  reduce,
  onRetryNow,
  onDisconnect,
}: {
  attempt: number
  retryInMs: number | null
  reduce: boolean
  onRetryNow: () => void
  onDisconnect?: () => void
}) {
  const secs = retryInMs != null ? Math.ceil(retryInMs / 1000) : null
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="flex flex-col items-center text-center"
    >
      <div className="flex items-center gap-2 text-[13px]" style={{ color: C.textSoft }}>
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: C.amber }} />
        <span>
          连接已中断，第 {attempt} 次自动重连
          {secs != null && secs > 0 ? ` · ${secs}s 后开始` : " 即将开始"}
        </span>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <StageButton tone="primary" onClick={onRetryNow}>
          <RotateCw className="h-3.5 w-3.5" /> 立即重试
        </StageButton>
        {onDisconnect && (
          <StageButton tone="ghost" onClick={onDisconnect}>
            <Plug className="h-3.5 w-3.5" /> 断开
          </StageButton>
        )}
      </div>
    </motion.div>
  )
}

// ----- Closed: clean reconnect CTA -------------------------------------------

function ClosedPanel({ reduce, onRetry }: { reduce: boolean; onRetry: () => void }) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="flex flex-col items-center text-center"
    >
      <p className="text-[13px] leading-relaxed" style={{ color: C.textSoft }}>
        远端桌面会话已断开。
      </p>
      <div className="mt-5">
        <StageButton tone="primary" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" /> 重新连接
        </StageButton>
      </div>
    </motion.div>
  )
}

// ----- Error: friendly headline + recovery + collapsible detail --------------

const KIND_EXPLAIN: Record<ConnError["kind"], string> = {
  security: "远端要求的安全层(通常是 NLA)未能协商成功。可尝试禁用 NLA 重连，或改用经典 RDP 通道。",
  auth: "目标主机拒绝了当前凭据。核对账号资料里的用户名与密码后重试。",
  network: "没能连到目标主机。确认主机在线、端口可达，再重试。",
  timeout: "等待远端响应超时。可能是主机繁忙或网络拥塞，稍后重试。",
  unsupported: "所选后端尚未在服务端就绪。可改用经典 RDP 通道继续。",
  generic: "连接在建立过程中中断。重试通常可恢复；若反复失败可改用经典 RDP。",
}

function ErrorPanel({
  error,
  reduce,
  onRetry,
  onForceTlsOnly,
  onSwitchToGuacamole,
}: {
  error: ConnError | null
  reduce: boolean
  onRetry: () => void
  onForceTlsOnly?: () => void
  onSwitchToGuacamole?: () => void
}) {
  const [showDetail, setShowDetail] = React.useState(false)
  const kind = error?.kind ?? "generic"
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease: EASE }}
    >
      <div
        className="flex items-start gap-3 rounded-xl border p-3.5"
        style={{ borderColor: "rgba(224,102,76,0.28)", background: "rgba(224,102,76,0.07)" }}
      >
        <TriangleAlert className="mt-px h-4 w-4 shrink-0" style={{ color: C.red }} />
        <div className="min-w-0">
          <p className="text-[13px] font-medium" style={{ color: C.text }}>
            {error?.title ?? "连接未能建立"}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: C.textSoft }}>
            {KIND_EXPLAIN[kind]}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <StageButton tone="primary" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" /> 重试
        </StageButton>
        {error?.canForceTls && onForceTlsOnly && (
          <StageButton tone="outline" onClick={onForceTlsOnly}>
            <ShieldOff className="h-3.5 w-3.5" /> 禁用 NLA 重试
          </StageButton>
        )}
        {onSwitchToGuacamole && (
          <StageButton tone="outline" onClick={onSwitchToGuacamole}>
            <ShieldCheck className="h-3.5 w-3.5" /> 切换经典 RDP
          </StageButton>
        )}
      </div>

      {error?.detail && (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] transition-colors"
            style={{ color: C.textFaint }}
          >
            技术详情
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", showDetail && "rotate-180")}
            />
          </button>
          <AnimatePresence>
            {showDetail && (
              <motion.pre
                initial={reduce ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduce ? undefined : { opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="mt-2 overflow-hidden whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-left font-mono text-[11px] leading-relaxed"
                style={{ borderColor: C.hair, color: C.textSoft, background: "#1a1916" }}
              >
                {error.detail}
                {error.code != null && error.code !== 0
                  ? `\n错误码 0x${error.code.toString(16).padStart(8, "0").toUpperCase()}`
                  : ""}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  )
}

// ----- Bits ------------------------------------------------------------------

function Dot() {
  return <span style={{ color: C.textFaint }}>·</span>
}

function StageButton({
  tone,
  onClick,
  children,
}: {
  tone: "primary" | "outline" | "ghost"
  onClick: () => void
  children: React.ReactNode
}) {
  const base =
    "inline-flex h-8 items-center gap-1.5 rounded-md px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2"
  if (tone === "primary") {
    return (
      <button
        type="button"
        onClick={onClick}
        className={base}
        style={{ background: C.coral, color: "#fff" }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#b86a50")}
        onMouseLeave={(e) => (e.currentTarget.style.background = C.coral)}
      >
        {children}
      </button>
    )
  }
  if (tone === "ghost") {
    return (
      <button
        type="button"
        onClick={onClick}
        className={base}
        style={{ color: C.textSoft }}
        onMouseEnter={(e) => (e.currentTarget.style.color = C.text)}
        onMouseLeave={(e) => (e.currentTarget.style.color = C.textSoft)}
      >
        {children}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={base}
      style={{ border: `1px solid ${C.hair}`, color: C.text, background: "rgba(245,241,234,0.04)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(245,241,234,0.09)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(245,241,234,0.04)")}
    >
      {children}
    </button>
  )
}
