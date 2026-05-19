"use client"

// Port-forward live event provider + hooks.
//
// Owns a single PortForwardEventsClient and fans events out to React
// consumers without forcing a re-render storm: per-forward stats live in
// a useSyncExternalStore snapshot so each subscribed row only re-renders
// when its own counters change. Sparkline history (last ~60 s of byte
// rate) is kept in the same store so the chart components do not need
// their own ring buffer.

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  PortForwardEventsClient,
  type PortForwardEvent,
} from "@/lib/portfwd/events-client"
import type { HistoryPoint } from "@/lib/hooks/use-insights-history"
import type { PortForward } from "@/lib/api/types"

const HISTORY_WINDOW_MS = 60_000
const HISTORY_MAX_POINTS = 240

export interface LiveStats {
  bytesIn: number
  bytesOut: number
  inRateBps: number
  outRateBps: number
  activeConns: number
  rateHistory: HistoryPoint[]
  lastUpdateMs: number
}

type Listener = () => void

class LiveStore {
  private byId = new Map<string, LiveStats>()
  private listeners = new Set<Listener>()
  private status: "connecting" | "open" | "closed" | "error" = "closed"
  private statusListeners = new Set<Listener>()
  private latencyMs: number | null = null
  private latencyListeners = new Set<Listener>()

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  subscribeStatus(cb: Listener): () => void {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  subscribeLatency(cb: Listener): () => void {
    this.latencyListeners.add(cb)
    return () => this.latencyListeners.delete(cb)
  }

  getSnapshot(): Map<string, LiveStats> {
    return this.byId
  }

  getStatus() { return this.status }
  getLatency() { return this.latencyMs }

  setStatus(s: typeof this.status) {
    this.status = s
    for (const l of this.statusListeners) l()
  }

  setLatency(ms: number) {
    this.latencyMs = ms
    for (const l of this.latencyListeners) l()
  }

  apply(event: PortForwardEvent) {
    const prior = this.byId.get(event.forward_id) ?? {
      bytesIn: 0,
      bytesOut: 0,
      inRateBps: 0,
      outRateBps: 0,
      activeConns: 0,
      rateHistory: [],
      lastUpdateMs: event.ts_ms,
    }
    let next: LiveStats = prior
    switch (event.type) {
      case "bytes_tick": {
        const inRate = event.in_rate_bps ?? 0
        const outRate = event.out_rate_bps ?? 0
        const rateTotal = inRate + outRate
        const point: HistoryPoint = { t: event.ts_ms, v: rateTotal }
        const cutoff = event.ts_ms - HISTORY_WINDOW_MS
        const trimmed = prior.rateHistory.filter((p) => p.t >= cutoff)
        trimmed.push(point)
        if (trimmed.length > HISTORY_MAX_POINTS) {
          trimmed.splice(0, trimmed.length - HISTORY_MAX_POINTS)
        }
        next = {
          ...prior,
          bytesIn: event.bytes_in ?? prior.bytesIn,
          bytesOut: event.bytes_out ?? prior.bytesOut,
          inRateBps: inRate,
          outRateBps: outRate,
          activeConns: event.active_conns ?? prior.activeConns,
          rateHistory: trimmed,
          lastUpdateMs: event.ts_ms,
        }
        break
      }
      case "conn_open":
      case "conn_close": {
        next = {
          ...prior,
          activeConns: event.active_conns ?? prior.activeConns,
          lastUpdateMs: event.ts_ms,
        }
        break
      }
      case "closed": {
        // Keep last-known totals so the row does not flicker to zero on
        // delete; the REST list will replace this entry shortly anyway.
        next = { ...prior, lastUpdateMs: event.ts_ms }
        break
      }
      default:
        return
    }
    // Always replace the map reference so identity-based memo (Object.is)
    // observers see the change.
    this.byId = new Map(this.byId)
    this.byId.set(event.forward_id, next)
    for (const l of this.listeners) l()
  }

  reset() {
    this.byId = new Map()
    for (const l of this.listeners) l()
  }
}

const Ctx = React.createContext<LiveStore | null>(null)

export function PortForwardEventsProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient()
  const storeRef = React.useRef<LiveStore | null>(null)
  if (!storeRef.current) {
    storeRef.current = new LiveStore()
  }
  const store = storeRef.current

  React.useEffect(() => {
    const client = new PortForwardEventsClient({
      onStatus: (s) => store.setStatus(s),
      onLatency: (ms) => store.setLatency(ms),
      onEvent: (ev) => {
        store.apply(ev)
        // Mirror cumulative bytes into the cached list so the table stays
        // accurate even without a refetch — but only when we actually have
        // fresh totals (bytes_tick). The rest leave the cached row alone.
        if (ev.type === "bytes_tick") {
          qc.setQueryData<{ port_forwards: PortForward[] }>(
            ["portfwd"],
            (prev) => {
              if (!prev) return prev
              const port_forwards = prev.port_forwards.map((row) =>
                row.id === ev.forward_id
                  ? { ...row, bytes_in: ev.bytes_in, bytes_out: ev.bytes_out }
                  : row,
              )
              return { ...prev, port_forwards }
            },
          )
        }
        // Lifecycle changes (open/close/metadata) should re-fetch so we
        // pick up new rows and updated metadata. Background-only, no
        // visible spinner.
        if (
          ev.type === "opened" ||
          ev.type === "closed" ||
          ev.type === "metadata"
        ) {
          void qc.invalidateQueries({ queryKey: ["portfwd"] })
        }
      },
    })
    client.start()
    return () => {
      client.stop()
      store.reset()
    }
  }, [qc, store])

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

/**
 * useForwardLive returns the live snapshot for a single forwarder. The
 * component only re-renders when this row's counters change; other rows
 * mutating the store do not invalidate this consumer (still works thanks
 * to useSyncExternalStore's cached snapshot equality).
 */
export function useForwardLive(forwardID: string): LiveStats | null {
  const store = React.useContext(Ctx)
  const subscribe = React.useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : () => {}),
    [store],
  )
  const getSnapshot = React.useCallback(() => {
    return store ? store.getSnapshot().get(forwardID) ?? null : null
  }, [store, forwardID])
  return React.useSyncExternalStore(subscribe, getSnapshot, () => null)
}

/**
 * useAllForwardLive returns the full Map<forwardID, LiveStats>. Useful
 * for top-level summaries (e.g. "all-forwards aggregate rate"); rows
 * should prefer useForwardLive for granular re-renders.
 */
export function useAllForwardLive(): Map<string, LiveStats> {
  const store = React.useContext(Ctx)
  const subscribe = React.useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : () => {}),
    [store],
  )
  const getSnapshot = React.useCallback(
    () => (store ? store.getSnapshot() : new Map<string, LiveStats>()),
    [store],
  )
  const empty = React.useRef(new Map<string, LiveStats>())
  return React.useSyncExternalStore(subscribe, getSnapshot, () => empty.current)
}

export function useForwardEventsStatus() {
  const store = React.useContext(Ctx)
  const subscribe = React.useCallback(
    (cb: () => void) => (store ? store.subscribeStatus(cb) : () => {}),
    [store],
  )
  const getSnapshot = React.useCallback(
    () => store?.getStatus() ?? "closed",
    [store],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, () => "closed" as const)
}

export function useForwardEventsLatency(): number | null {
  const store = React.useContext(Ctx)
  const subscribe = React.useCallback(
    (cb: () => void) => (store ? store.subscribeLatency(cb) : () => {}),
    [store],
  )
  const getSnapshot = React.useCallback(
    () => store?.getLatency() ?? null,
    [store],
  )
  return React.useSyncExternalStore(subscribe, getSnapshot, () => null)
}
