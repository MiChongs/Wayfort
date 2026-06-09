"use client"

import * as React from "react"

// Sparkline — a tiny, dependency-free trend line for a metric card. Stretches to
// fill its container (viewBox + preserveAspectRatio="none"), with a non-scaling
// stroke so the line stays crisp. null values break the line into segments so a
// gap reads as "unmeasured" rather than a drop to zero.
export function Sparkline({
  data,
  color,
  height = 30,
}: {
  data: (number | null)[]
  color: string
  height?: number
}) {
  const id = React.useId().replace(/:/g, "")
  const W = 100
  const PAD = 3

  const nums = data.filter((v): v is number => v != null)
  if (nums.length < 2) {
    return <div style={{ height }} aria-hidden />
  }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const range = max - min || 1
  const n = data.length
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W)
  const y = (v: number) => height - PAD - ((v - min) / range) * (height - PAD * 2)

  // Build line segments split on nulls.
  const segments: string[] = []
  let cur: string[] = []
  data.forEach((v, i) => {
    if (v == null) {
      if (cur.length) segments.push(cur.join(" ")), (cur = [])
      return
    }
    cur.push(`${cur.length ? "L" : "M"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`)
  })
  if (cur.length) segments.push(cur.join(" "))
  const linePath = segments.join(" ")

  // Soft area wash — only for a gapless series, so a single closed path can't
  // smear across null breaks. Sparse-null series (latency) show just the line.
  const hasGap = data.some((v) => v == null)
  const firstIdx = data.findIndex((v) => v != null)
  const lastIdx = data.length - 1
  const areaPath = !hasGap && firstIdx >= 0
    ? `${linePath} L${x(lastIdx).toFixed(2)} ${height} L${x(firstIdx).toFixed(2)} ${height} Z`
    : ""

  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={`spk-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      {areaPath && <path d={areaPath} fill={`url(#spk-${id})`} stroke="none" />}
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
