"use client"

import * as React from "react"

/**
 * useInsightsHistory keeps a sliding window of `capacity` samples extracted
 * from a stream of objects. Each fresh `data` reference appends one point;
 * the array auto-trims to capacity. Used by sparkline charts on the SSH
 * insights dashboard.
 *
 * The hook is reference-stable: callers can pass it to recharts directly
 * without triggering unnecessary re-renders when nothing actually changed.
 */
export interface HistoryPoint {
  t: number
  v: number
}

export function useInsightsHistory<T>(
  data: T | undefined,
  pick: (d: T) => number,
  capacity = 60,
): HistoryPoint[] {
  const [points, setPoints] = React.useState<HistoryPoint[]>([])
  // Track last reference so we only push once per change.
  const lastRef = React.useRef<T | undefined>(undefined)
  React.useEffect(() => {
    if (!data || data === lastRef.current) return
    lastRef.current = data
    const v = pick(data)
    if (!Number.isFinite(v)) return
    setPoints((prev) => {
      const next = prev.length >= capacity ? prev.slice(prev.length - capacity + 1) : prev.slice()
      next.push({ t: Date.now(), v })
      return next
    })
    // pick is stable per consumer; we deliberately don't depend on it to
    // avoid re-running for every render that re-creates an inline arrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, capacity])
  return points
}
