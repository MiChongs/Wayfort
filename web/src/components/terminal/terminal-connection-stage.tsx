"use client"

// Terminal connection stage — a theme-adaptive scrim + warm card that owns the
// terminal area until the shell is live. Mirrors the desktop's connection stage
// but uses design tokens (bg-card / foreground / coral) so it blends with both
// light and dark terminal themes, and a translucent scrim so a failure/reconnect
// dims the existing output rather than hiding it.

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Check,
  ChevronDown,
  Loader2,
  Plug,
  RotateCw,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SignalBars, LatencySparkline } from "@/components/desktop/desktop-signal"
import { formatSeconds } from "@/components/desktop/desktop-connection"
import { SUGGESTION_LABEL, type TerminalConnection } from "./terminal-connection"

const EASE = [0.22, 1, 0.36, 1] as const

type Props = {
  conn: TerminalConnection
  nodeName?: string
  subtitle?: string
  protocolLabel?: string
  onRetry: () => void
  onRetryNow?: () => void
  onDisconnect?: () => void
  onNavigate?: (href: string) => void
}

export function TerminalConnectionStage({
  conn,
  nodeName,
  subtitle,
  protocolLabel,
  onRetry,
  onRetryNow,
  onDisconnect,
  onNavigate,
}: Props) {
  const reduce = useReducedMotion()
  const { status } = conn
  const visible = status !== "open"

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
    <AnimatePresence>
      {visible && (
        <motion.div
          key="term-stage"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.35, ease: EASE }}
          className="absolute inset-0 z-20 flex items-center justify-center bg-background/75 p-4 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="w-full max-w-[24rem] rounded-2xl border bg-card p-6 shadow-xl"
          >
            {/* Header */}
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                  isError ? "bg-destructive/10 text-destructive" : "bg-primary/12 text-primary",
                )}
              >
                <TerminalSquare className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <span
                  className="eyebrow"
                  style={isError ? { color: "var(--destructive)" } : { color: "var(--primary)" }}
                >
                  {eyebrow}
                </span>
                <h2 className="mt-0.5 truncate text-[15px] font-medium leading-tight" title={nodeName}>
                  {nodeName || "远端主机"}
                </h2>
                {subtitle && (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {subtitle}
                    {protocolLabel ? <span className="uppercase"> · {protocolLabel}</span> : null}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-5">
              <AnimatePresence mode="wait">
                {isError ? (
                  <ErrorPanel key="error" conn={conn} reduce={!!reduce} onRetry={onRetry} onNavigate={onNavigate} />
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
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ----- Connecting: the live timed stepper ------------------------------------

function ConnectingPanel({ conn, reduce }: { conn: TerminalConnection; reduce: boolean }) {
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
          return (
            <motion.li
              key={step.key}
              initial={reduce ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, ease: EASE, delay: reduce ? 0 : i * 0.05 }}
              className="relative flex gap-3 pb-3 last:pb-0"
            >
              {!last && (
                <span
                  className={cn(
                    "absolute left-[8.5px] top-[20px] bottom-0 w-px",
                    step.state === "done" ? "bg-[#5db872]" : "bg-border",
                  )}
                />
              )}
              <StepDot state={step.state} />
              <div className="min-w-0 flex-1 pt-px">
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "text-[13px]",
                      step.state === "pending"
                        ? "text-muted-foreground/60"
                        : step.state === "active"
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                  {step.durationMs != null && (
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                      {formatSeconds(step.durationMs)}
                    </span>
                  )}
                </div>
                <AnimatePresence>
                  {step.state === "active" && (
                    <motion.p
                      initial={reduce ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={reduce ? undefined : { opacity: 0, height: 0 }}
                      transition={{ duration: 0.25, ease: EASE }}
                      className="overflow-hidden text-[11.5px] leading-relaxed text-muted-foreground/70"
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

      <div className="mt-4 flex items-center justify-between border-t pt-3">
        <span className="font-mono text-[11px] text-muted-foreground/70">
          已用时 {formatSeconds(conn.elapsedMs)}
        </span>
        <span className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className="text-muted-foreground/60">
            <SignalBars level={quality.level} tone={quality.tone} />
          </span>
          {latencyMs != null ? (
            <span>
              {quality.label} · <span className="font-mono">{latencyMs}ms</span>
            </span>
          ) : (
            <span className="text-muted-foreground/60">链路测量中</span>
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
        className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[#5db872]"
      >
        <Check className="h-3 w-3" strokeWidth={3} style={{ color: "#0c1f16" }} />
      </motion.span>
    )
  }
  if (state === "active") {
    return (
      <span className="relative z-10 flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <Loader2 className="h-[18px] w-[18px] animate-spin text-primary" strokeWidth={2.5} />
      </span>
    )
  }
  return <span className="relative z-10 mt-px h-[16px] w-[16px] shrink-0 rounded-full border bg-muted" />
}

// ----- Reconnecting ----------------------------------------------------------

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
      <p className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-[#c08a2e] dark:text-[#e3b84e]" />
        第 {attempt} 次自动重连{secs != null && secs > 0 ? ` · ${secs}s 后开始` : " 即将开始"}
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button size="sm" className="h-8" onClick={onRetryNow}>
          <RotateCw className="h-3.5 w-3.5" /> 立即重试
        </Button>
        {onDisconnect && (
          <Button size="sm" variant="ghost" className="h-8" onClick={onDisconnect}>
            <Plug className="h-3.5 w-3.5" /> 断开
          </Button>
        )}
      </div>
    </motion.div>
  )
}

// ----- Closed ----------------------------------------------------------------

function ClosedPanel({ reduce, onRetry }: { reduce: boolean; onRetry: () => void }) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="flex flex-col items-center text-center"
    >
      <p className="text-[13px] leading-relaxed text-muted-foreground">会话已断开。</p>
      <div className="mt-5">
        <Button size="sm" className="h-8" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" /> 重新连接
        </Button>
      </div>
    </motion.div>
  )
}

// ----- Error -----------------------------------------------------------------

function ErrorPanel({
  conn,
  reduce,
  onRetry,
  onNavigate,
}: {
  conn: TerminalConnection
  reduce: boolean
  onRetry: () => void
  onNavigate?: (href: string) => void
}) {
  const [showDetail, setShowDetail] = React.useState(false)
  const err = conn.error
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, y: -6 }}
      transition={{ duration: 0.25, ease: EASE }}
    >
      <div className="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/[0.06] p-3.5">
        <TriangleAlert className="mt-px h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{err?.title ?? "连接已断开"}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {err?.detail ?? "重试通常可恢复。"}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" className="h-8" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" /> 重试
        </Button>
        {err?.href && onNavigate && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => onNavigate(err.href!)}>
            {SUGGESTION_LABEL[err.suggestion]}
          </Button>
        )}
      </div>

      {err?.raw && (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
          >
            技术详情
            <ChevronDown className={cn("h-3 w-3 transition-transform", showDetail && "rotate-180")} />
          </button>
          <AnimatePresence>
            {showDetail && (
              <motion.pre
                initial={reduce ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduce ? undefined : { opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="mt-2 overflow-hidden whitespace-pre-wrap break-words rounded-lg border bg-muted/50 px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-muted-foreground"
              >
                {err.raw}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  )
}
