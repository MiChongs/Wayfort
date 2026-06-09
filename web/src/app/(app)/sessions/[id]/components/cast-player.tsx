"use client"

import * as React from "react"
import type { AuditEvent } from "@/lib/api/types"
import { auditMeta } from "@/lib/session-meta"
import type { ReplayController } from "@/lib/viz/replay-sync"
import { eventOffsetMs } from "@/lib/viz/replay-sync"

type AsciinemaInstance = {
  dispose?: () => void
  getCurrentTime?: () => number
  seek?: (loc: number) => void
  play?: () => void
  pause?: () => void
  addEventListener?: (type: string, fn: (...args: unknown[]) => void) => void
}

// CastPlayer mounts asciinema-player (dynamic import — SSR-unsafe) and exposes a
// ReplayController so a <SyncedTimeline> can follow playback and seek on click.
// Audit events are injected as native markers on the player's seek bar, and a
// requestAnimationFrame loop publishes the playhead while playing (asciinema has
// no continuous timeupdate event).
export function CastPlayer({
  url,
  events,
  sessionStart,
  sessionDurationMs,
  onController,
}: {
  url: string
  events: AuditEvent[]
  sessionStart: string
  sessionDurationMs: number
  onController?: (c: ReplayController | null) => void
}) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const onControllerRef = React.useRef(onController)
  onControllerRef.current = onController

  // Markers are derived once per events/start change; the player is recreated
  // with them (asciinema takes markers at create time).
  const markers = React.useMemo(
    () =>
      events
        .map((e) => [eventOffsetMs(e.created_at, sessionStart, sessionDurationMs) / 1000, auditMeta(e.kind).label] as [number, string])
        .filter(([t]) => t >= 0),
    [events, sessionStart, sessionDurationMs],
  )

  React.useEffect(() => {
    let disposed = false
    let inst: AsciinemaInstance | null = null
    let raf = 0
    const timeSubs = new Set<(ms: number) => void>()
    const playSubs = new Set<(p: boolean) => void>()
    let playing = false
    let maxSeen = sessionDurationMs

    const emitTime = () => {
      const ms = (inst?.getCurrentTime?.() ?? 0) * 1000
      if (ms > maxSeen) maxSeen = ms
      for (const cb of timeSubs) cb(ms)
    }
    const loop = () => {
      if (!playing) return
      emitTime()
      raf = requestAnimationFrame(loop)
    }
    const setPlaying = (p: boolean) => {
      playing = p
      for (const cb of playSubs) cb(p)
      if (p) {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(loop)
      } else {
        cancelAnimationFrame(raf)
        emitTime()
      }
    }

    ;(async () => {
      try {
        const player = await import("asciinema-player")
        if (disposed || !ref.current) return
        inst = player.create(url, ref.current, {
          fit: "width",
          theme: "monokai",
          autoPlay: false,
          preload: true,
          terminalFontSize: "14px",
          idleTimeLimit: 2,
          markers,
        }) as AsciinemaInstance
        inst.addEventListener?.("play", () => setPlaying(true))
        inst.addEventListener?.("playing", () => setPlaying(true))
        inst.addEventListener?.("pause", () => setPlaying(false))
        inst.addEventListener?.("ended", () => setPlaying(false))

        const controller: ReplayController = {
          durationMs: () => maxSeen,
          getCurrentMs: () => (inst?.getCurrentTime?.() ?? 0) * 1000,
          seekMs: (ms) => {
            inst?.seek?.(ms / 1000)
            emitTime()
          },
          play: () => inst?.play?.(),
          pause: () => inst?.pause?.(),
          isPlaying: () => playing,
          onTime: (cb) => {
            timeSubs.add(cb)
            return () => timeSubs.delete(cb)
          },
          onPlayState: (cb) => {
            playSubs.add(cb)
            return () => playSubs.delete(cb)
          },
        }
        onControllerRef.current?.(controller)
      } catch (e) {
        if (ref.current) ref.current.textContent = "录像播放器加载失败：" + String(e)
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      onControllerRef.current?.(null)
      inst?.dispose?.()
    }
  }, [url, markers, sessionDurationMs])

  return (
    <div className="overflow-hidden rounded-md border bg-black">
      <div ref={ref} className="ap-host min-h-[420px] w-full" />
    </div>
  )
}
