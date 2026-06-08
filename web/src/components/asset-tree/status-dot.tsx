"use client"

import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { NodeStatus } from "@/lib/api/types"

// Tri-state connectivity dot for asset rows, mirroring the proxy HealthDot's
// warm-semantic palette (sage / brick / muted — never cool sky/emerald, per
// DESIGN.md). "checking" shows a tiny spinner instead of a dot.
export type DotState = "online" | "offline" | "unknown" | "checking"

const TONE: Record<Exclude<DotState, "checking">, string> = {
  online: "bg-success",
  offline: "bg-destructive",
  unknown: "bg-muted-foreground/40",
}

const LABEL: Record<DotState, string> = {
  online: "在线",
  offline: "离线 / 不可达",
  unknown: "未探测",
  checking: "探测中",
}

export function statusToState(s?: NodeStatus | null, checking?: boolean): DotState {
  if (checking) return "checking"
  if (!s || s.forbidden) return "unknown"
  return s.online ? "online" : "offline"
}

export function StatusDot({
  state = "unknown",
  latencyMs,
  pulse = true,
  className,
}: {
  state?: DotState
  latencyMs?: number
  pulse?: boolean
  className?: string
}) {
  if (state === "checking") {
    return (
      <Loader2
        className={cn("h-3 w-3 shrink-0 animate-spin text-muted-foreground", className)}
        aria-label={LABEL.checking}
      />
    )
  }
  const title = state === "online" && latencyMs != null ? `在线 · ${latencyMs}ms` : LABEL[state]
  return (
    <span
      className={cn("relative inline-flex h-2 w-2 shrink-0 rounded-full", TONE[state], className)}
      title={title}
      aria-label={title}
    >
      {state === "online" && pulse && (
        <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-success/60" />
      )}
    </span>
  )
}

// StatusBadge is the verbose form for the detail panel: dot + label + latency.
export function StatusBadge({ status, checking }: { status?: NodeStatus | null; checking?: boolean }) {
  const state = statusToState(status, checking)
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <StatusDot state={state} latencyMs={status?.latency_ms} />
      <span>{LABEL[state]}</span>
      {state === "online" && status?.latency_ms != null && (
        <span className="tabular-nums text-muted-foreground/80">{status.latency_ms}ms</span>
      )}
      {state === "offline" && status?.error && (
        <span className="max-w-[200px] truncate text-destructive/80" title={status.error}>
          {status.error}
        </span>
      )}
    </span>
  )
}
