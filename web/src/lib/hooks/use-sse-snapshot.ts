"use client"

import * as React from "react"
import { streamSSE } from "@/lib/sse/eventsource"

export type SseStatus = "idle" | "connecting" | "live" | "error"

export interface SseSnapshot<T> {
  data: T | undefined
  status: SseStatus
  error: string | null
  /** epoch ms of the last snapshot frame, or null before the first arrives. */
  lastAt: number | null
}

/**
 * useSseSnapshot subscribes to a backend `…/stream` endpoint that emits
 * `event: snapshot` frames (see internal/sse). It:
 *   • renders the latest snapshot as soon as it arrives — never blocks,
 *   • auto-reconnects with exponential backoff (1s→15s) if the stream drops,
 *   • aborts cleanly on unmount or when `enabled` flips false (e.g. the dock
 *     tab is hidden), killing the server-side remote loop too.
 *
 * `url` should be stable (memoise it from nodeId); changing it re-subscribes.
 */
export function useSseSnapshot<T>(
  url: string | null | undefined,
  opts?: { enabled?: boolean },
): SseSnapshot<T> {
  const enabled = opts?.enabled ?? true
  const [data, setData] = React.useState<T | undefined>(undefined)
  const [status, setStatus] = React.useState<SseStatus>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [lastAt, setLastAt] = React.useState<number | null>(null)

  React.useEffect(() => {
    if (!enabled || !url) {
      setStatus("idle")
      return
    }
    let stopped = false
    const ctrl = new AbortController()
    let attempt = 0
    let timer: number | null = null

    const connect = async () => {
      if (stopped) return
      setStatus((s) => (s === "live" ? s : "connecting"))
      try {
        await streamSSE(url, { signal: ctrl.signal }, (kind, payload) => {
          if (stopped) return
          if (kind === "snapshot") {
            setData(payload as T)
            setStatus("live")
            setError(null)
            setLastAt(Date.now())
            attempt = 0
          } else if (kind === "err") {
            setError(typeof payload === "string" ? payload : JSON.stringify(payload))
          }
        })
        // streamSSE resolved → the server closed the stream cleanly; reconnect.
      } catch (e) {
        if (stopped || ctrl.signal.aborted) return
        setStatus("error")
        setError(e instanceof Error ? e.message : String(e))
      }
      if (stopped || ctrl.signal.aborted) return
      const delay = Math.min(1000 * 2 ** attempt, 15000)
      attempt += 1
      timer = window.setTimeout(connect, delay)
    }

    void connect()
    return () => {
      stopped = true
      ctrl.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [url, enabled])

  return { data, status, error, lastAt }
}
