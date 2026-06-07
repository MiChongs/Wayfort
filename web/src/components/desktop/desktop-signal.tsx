"use client"

// Small shared visual primitives for the desktop chrome: a four-bar link-
// quality meter and a latency sparkline. Both are driven by real measured RTT
// (see desktop-connection.ts) — no decorative fakery. Filled colour comes from
// the quality tone; the empty track inherits `currentColor`, so a caller sets
// the track shade by setting its own text colour (muted on light chrome,
// faint-white on the dark connection stage).

import * as React from "react"
import { cn } from "@/lib/utils"
import type { QualityTone } from "./desktop-connection"

// Warm signal palette — the same hexes read correctly on both the light
// toolbar/status bar and the dark connection stage, so they're fixed rather
// than theme tokens (which would resolve to ink on a dark surface).
export const TONE_HEX: Record<QualityTone, string> = {
  good: "#5db872", // sage success
  fair: "#e8a55a", // warm amber
  poor: "#e0664c", // warm red
  muted: "#8e8b82", // neutral
}

const SIZES = {
  sm: { bars: [4, 6, 8, 10], gap: "gap-[2px]", width: "w-[3px]" },
  md: { bars: [6, 9, 12, 15], gap: "gap-[3px]", width: "w-[3.5px]" },
} as const

export function SignalBars({
  level,
  tone,
  size = "sm",
  className,
  animate = true,
}: {
  level: number
  tone: QualityTone
  size?: keyof typeof SIZES
  className?: string
  animate?: boolean
}) {
  const cfg = SIZES[size]
  const fill = TONE_HEX[tone]
  return (
    <span
      className={cn("inline-flex items-end", cfg.gap, className)}
      role="img"
      aria-label={`链路信号 ${level}/4`}
    >
      {cfg.bars.map((h, i) => {
        const on = i < level
        return (
          <span
            key={i}
            className={cn("rounded-[1.5px]", cfg.width)}
            style={{
              height: h,
              backgroundColor: on ? fill : "currentColor",
              opacity: on ? 1 : 0.22,
              transition: animate ? "background-color 240ms ease, opacity 240ms ease" : undefined,
            }}
          />
        )
      })}
    </span>
  )
}

// LatencySparkline plots the recent RTT history as a thin line. Self-scaling
// against its own min/max so jitter is visible even when the absolute numbers
// are small; a dot pins the latest sample.
export function LatencySparkline({
  points,
  tone,
  width = 56,
  height = 16,
  className,
}: {
  points: number[]
  tone: QualityTone
  width?: number
  height?: number
  className?: string
}) {
  const pts = points.length > 28 ? points.slice(points.length - 28) : points
  const stroke = TONE_HEX[tone]
  if (pts.length < 2) {
    // Not enough samples yet — a faint baseline keeps the slot from jumping.
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line
          x1={0}
          y1={height - 1.5}
          x2={width}
          y2={height - 1.5}
          stroke="currentColor"
          strokeOpacity={0.25}
          strokeWidth={1}
        />
      </svg>
    )
  }
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = Math.max(1, max - min)
  const pad = 2
  const innerH = height - pad * 2
  const stepX = width / (pts.length - 1)
  const coords = pts.map((p, i) => {
    const x = i * stepX
    // Invert: lower latency sits higher (better).
    const y = pad + innerH - ((p - min) / span) * innerH
    return [x, y] as const
  })
  const d = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")
  const [lx, ly] = coords[coords.length - 1]
  return (
    <svg width={width} height={height} className={className} aria-label="延迟趋势">
      <polyline
        points={d}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lx} cy={ly} r={1.8} fill={stroke} />
    </svg>
  )
}
