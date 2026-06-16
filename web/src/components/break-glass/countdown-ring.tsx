"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

// useNow ticks every `ms` while `active`, so a countdown re-renders live without
// the parent re-fetching.
function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

function leftLabel(leftMs: number): string {
  if (leftMs <= 0) return "已到期"
  const s = Math.floor(leftMs / 1000)
  if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
  return `${s}s`
}

// LiveRemaining is a compact, live-ticking "time left" label for list rows.
export function LiveRemaining({ notAfter, className }: { notAfter?: string | null; className?: string }) {
  const end = notAfter ? Date.parse(notAfter) : NaN
  const valid = !Number.isNaN(end)
  const now = useNow(valid)
  const left = valid ? Math.max(0, end - now) : 0
  const soon = left > 0 && left < 5 * 60 * 1000
  return (
    <span
      className={cn(
        "tabular-nums",
        left <= 0 ? "text-muted-foreground" : soon ? "text-destructive" : "text-orange-600",
        className,
      )}
    >
      {leftLabel(left)}
    </span>
  )
}

// CountdownRing visualises the remaining window of an active break-glass grant
// as a depleting ring with a live time-left readout. Warm orange normally, turns
// destructive in the final 5 minutes.
export function CountdownRing({
  notBefore,
  notAfter,
  size = 76,
  stroke = 6,
  className,
  caption = "剩余",
}: {
  notBefore?: string | null
  notAfter?: string | null
  size?: number
  stroke?: number
  className?: string
  caption?: string
}) {
  const start = notBefore ? Date.parse(notBefore) : NaN
  const end = notAfter ? Date.parse(notAfter) : NaN
  const valid = !Number.isNaN(end)
  const now = useNow(valid)

  const total = end - start
  const left = valid ? Math.max(0, end - now) : 0
  const pctLeft = valid && total > 0 ? Math.max(0, Math.min(1, left / total)) : 0
  const soon = left > 0 && left < 5 * 60 * 1000
  const expired = valid && left <= 0

  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - pctLeft)
  const color = expired ? "text-muted-foreground" : soon ? "text-destructive" : "text-orange-500"

  return (
    <div className={cn("relative inline-flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className={cn("-rotate-90", soon && !expired && "animate-pulse")}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className={cn("transition-[stroke-dashoffset] duration-1000 ease-linear", color, "stroke-current")}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("text-sm font-semibold tabular-nums leading-none", color)}>{leftLabel(left)}</span>
        {!expired && <span className="mt-0.5 text-[10px] text-muted-foreground">{caption}</span>}
      </div>
    </div>
  )
}
