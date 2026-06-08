"use client"

import { cn } from "@/lib/utils"

// Latency thresholds (ms): healthy / acceptable / slow → sage / amber / brick.
export function latencyTone(ms: number): string {
  if (ms < 150) return "text-success"
  if (ms < 500) return "text-warning"
  return "text-destructive"
}

export function LatencyBadge({
  ms,
  className,
}: {
  ms: number | null | undefined
  className?: string
}) {
  if (ms == null || ms <= 0) return null // unknown — the dot already conveys state
  return (
    <span className={cn("font-mono tabular-nums text-[11px]", latencyTone(ms), className)}>{ms}ms</span>
  )
}
