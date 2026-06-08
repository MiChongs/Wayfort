"use client"

import { cn } from "@/lib/utils"
import type { ProxyHealthState } from "@/lib/api/types"

// Warm semantic tokens only — sage / amber / brick / muted. Never cool sky or
// emerald (DESIGN.md coral-only + warm-semantic rule).
const TONE: Record<ProxyHealthState, string> = {
  online: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/40",
}

export const HEALTH_LABEL: Record<ProxyHealthState, string> = {
  online: "在线",
  degraded: "降级",
  down: "离线",
  unknown: "未知",
}

export function HealthDot({
  state = "unknown",
  className,
  pulse = true,
  title,
}: {
  state?: ProxyHealthState
  className?: string
  pulse?: boolean
  title?: string
}) {
  return (
    <span
      className={cn("relative inline-flex h-2 w-2 shrink-0 rounded-full", TONE[state], className)}
      title={title ?? HEALTH_LABEL[state]}
      aria-label={HEALTH_LABEL[state]}
    >
      {state === "online" && pulse && (
        // motion-safe so it stays still for prefers-reduced-motion users.
        <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-success/60" />
      )}
    </span>
  )
}
