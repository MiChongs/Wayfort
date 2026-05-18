"use client"

import * as React from "react"
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts"
import { cn } from "@/lib/utils"
import type { HistoryPoint } from "@/lib/hooks/use-insights-history"

export interface SparklineProps {
  data: HistoryPoint[]
  // Y-axis bounds. Default 0..max-of-data.
  max?: number
  min?: number
  // Color hint — defaults to primary.
  color?: string
  className?: string
  height?: number
}

export function Sparkline({ data, max, min = 0, color, className, height = 40 }: SparklineProps) {
  const stroke = color ?? "hsl(var(--primary))"
  // Avoid SSR mismatch — recharts measures DOM.
  if (typeof window === "undefined") {
    return <div className={cn("text-[10px] text-muted-foreground", className)} style={{ height }} />
  }
  if (data.length < 2) {
    return (
      <div
        className={cn("text-[10px] text-muted-foreground flex items-center", className)}
        style={{ height }}
      >
        采集中…
      </div>
    )
  }
  return (
    <div className={cn("w-full", className)} style={{ height }}>
      {/*
        `minWidth={0}` silences Recharts' "width(0) and height(0)" warning
        that fires when the chart is measured on the first paint frame
        before the flex/grid parent has finished laying out. Without this
        the warning still appears in the Next.js dev devtools log every
        time the insights panel mounts.
      */}
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="sparklineFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[min, max ?? "dataMax"]} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={stroke}
            strokeWidth={1.5}
            fill="url(#sparklineFill)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
