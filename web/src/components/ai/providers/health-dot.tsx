"use client"

import { cn } from "@/lib/utils"
import type { ProviderHealth, ProviderHealthState } from "@/lib/api/types"
import type { SseStatus } from "@/lib/hooks/use-sse-snapshot"

const DOT: Record<ProviderHealthState, string> = {
  online: "bg-success",
  degraded: "bg-warning",
  offline: "bg-destructive",
  unknown: "bg-muted-foreground/40",
}

const LABEL: Record<ProviderHealthState, string> = {
  online: "在线",
  degraded: "降级",
  offline: "离线",
  unknown: "未知",
}

// HealthDot renders one provider's live reachability as a colored dot + latency.
// Shared by the list health column and the detail header. Fixed-width + truncate
// so dense rows never overflow; the error (if any) lands in the title tooltip.
export function HealthDot({
  health,
  status,
  showLabel = true,
}: {
  health?: ProviderHealth
  status?: SseStatus
  showLabel?: boolean
}) {
  // Stream not live yet and no prior snapshot → connecting placeholder.
  if (!health) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-2 rounded-full bg-muted-foreground/30" />
        {status === "connecting" ? "连接中…" : "—"}
      </span>
    )
  }
  const state = health.state ?? "unknown"
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-xs"
      title={health.last_error || LABEL[state]}
    >
      <span className={cn("size-2 shrink-0 rounded-full", DOT[state], state === "online" && "animate-pulse")} />
      {showLabel && <span className="text-foreground">{LABEL[state]}</span>}
      {typeof health.latency_ms === "number" && state !== "offline" && (
        <span className="tabular-nums text-muted-foreground">· {health.latency_ms}ms</span>
      )}
    </span>
  )
}
