"use client"

// Client-side perf ring buffer for the desktop session.
//
// The hook samples the live `SessionStats` object at 1 Hz and pushes
// derived per-second values into a fixed-length array. The chart
// component renders that array directly so the time axis is "seconds
// from session start" — no clock drift, no realtime tick callbacks
// inside the chart.
//
// We hold MAX_SAMPLES of history (600 = 10 min). Older points fall
// off the head. The buffer is recreated whenever `nodeId` flips —
// switching tabs starts a fresh perf timeline.
//
// `bytesInPerSec` / `bytesOutPerSec` are deltas: stats.bytesIn is
// cumulative from FrameClient so we diff against the previous sample
// to get rate. First sample always reads 0.

import * as React from "react"
import type { SessionStats } from "@/components/desktop/desktop-types"

export const MAX_SAMPLES = 600

export interface PerfSample {
  /** Milliseconds since session start (renders cleanly on a number axis). */
  t: number
  fps: number | null
  latencyMs: number | null
  bytesInPerSec: number
  bytesOutPerSec: number
  avgDecodeMs: number | null
  avgPaintMs: number | null
  /** Cumulative dropped-frames count when this sample was taken. */
  droppedFramesTotal: number | null
}

export interface PerfSummary {
  /** Last sample (convenient for "current value" cards). */
  current: PerfSample | null
  /** Arithmetic mean FPS across samples with a non-null fps value. */
  avgFps: number | null
  /** 95th percentile latency, sorted ascending. `null` if no samples. */
  p95LatencyMs: number | null
  /** Peak bytes/sec across the window (max of in + out). */
  peakBandwidthBps: number
}

/**
 * Returns a sampled history of `stats` + the latest summary.
 *
 *   - `sessionKey` — any stable identifier (e.g. `nodeId`); changing
 *      it clears the buffer (new session = fresh timeline).
 *   - `stats` — the live SessionStats from DesktopDisplay; sampled
 *      every 1s on a setInterval (not rAF, so it keeps ticking when
 *      the tab is backgrounded too).
 *   - `enabled` — pause sampling without unmounting the hook (e.g.
 *      when the perf panel is closed and the chart isn't visible).
 */
export function usePerfMetrics(
  sessionKey: string | number,
  stats: SessionStats,
  enabled = true,
): { samples: PerfSample[]; summary: PerfSummary; reset: () => void } {
  const [samples, setSamples] = React.useState<PerfSample[]>([])
  const startedAtRef = React.useRef<number>(0)
  const prevBytesInRef = React.useRef<number>(0)
  const prevBytesOutRef = React.useRef<number>(0)
  // Mirror live stats into a ref so the interval reads the latest value
  // without needing to re-fire when stats changes.
  const statsRef = React.useRef(stats)
  React.useEffect(() => {
    statsRef.current = stats
  }, [stats])

  // Reset everything when the session changes — different node, fresh
  // timeline. Stable callback so consumers can pass it to a reset button.
  const reset = React.useCallback(() => {
    setSamples([])
    startedAtRef.current = 0
    prevBytesInRef.current = 0
    prevBytesOutRef.current = 0
  }, [])
  React.useEffect(() => {
    reset()
  }, [sessionKey, reset])

  React.useEffect(() => {
    if (!enabled) return
    if (startedAtRef.current === 0) startedAtRef.current = Date.now()
    const tick = () => {
      const now = Date.now() - startedAtRef.current
      const live = statsRef.current
      const deltaIn = Math.max(0, live.bytesIn - prevBytesInRef.current)
      const deltaOut = Math.max(0, live.bytesOut - prevBytesOutRef.current)
      prevBytesInRef.current = live.bytesIn
      prevBytesOutRef.current = live.bytesOut
      const next: PerfSample = {
        t: now,
        fps: live.fps,
        latencyMs: live.latencyMs,
        bytesInPerSec: deltaIn,
        bytesOutPerSec: deltaOut,
        avgDecodeMs: live.avgDecodeMs ?? null,
        avgPaintMs: live.avgPaintMs ?? null,
        droppedFramesTotal: live.droppedFrames ?? null,
      }
      setSamples((prev) => {
        const arr = prev.length >= MAX_SAMPLES ? prev.slice(prev.length - MAX_SAMPLES + 1) : prev.slice()
        arr.push(next)
        return arr
      })
    }
    // Emit the first sample immediately so the chart isn't empty for
    // a whole second after the panel opens.
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [enabled])

  const summary: PerfSummary = React.useMemo(() => {
    if (samples.length === 0) {
      return { current: null, avgFps: null, p95LatencyMs: null, peakBandwidthBps: 0 }
    }
    const current = samples[samples.length - 1]
    const fpsVals = samples.map((s) => s.fps).filter((v): v is number => v != null)
    const avgFps =
      fpsVals.length > 0 ? Math.round(fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length) : null
    const latVals = samples
      .map((s) => s.latencyMs)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b)
    const p95LatencyMs =
      latVals.length > 0 ? latVals[Math.min(latVals.length - 1, Math.floor(latVals.length * 0.95))] : null
    const peakBandwidthBps = samples.reduce(
      (m, s) => Math.max(m, s.bytesInPerSec + s.bytesOutPerSec),
      0,
    )
    return { current, avgFps, p95LatencyMs, peakBandwidthBps }
  }, [samples])

  return { samples, summary, reset }
}
