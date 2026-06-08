"use client"

// On-demand node status. Asset rows call request(ids) as they become visible
// (expand / hover / mount); requests are deduped, coalesced into ~120ms batches,
// and skipped for ids probed within the last 30s so a big tree never hammers
// the backend (which itself caches probes ~20s + dials through the proxy chain).
// Mirrors the byId() ergonomics of use-proxy-health.

import * as React from "react"
import { nodeService } from "@/lib/api/services"
import type { NodeStatus } from "@/lib/api/types"

const STALE_MS = 30_000
const DEBOUNCE_MS = 120
const MAX_BATCH = 100

export function useNodeStatus() {
  const [statuses, setStatuses] = React.useState<Record<number, NodeStatus>>({})
  const [checking, setChecking] = React.useState<Set<number>>(() => new Set())
  const fetchedAt = React.useRef<Map<number, number>>(new Map())
  const pending = React.useRef<Set<number>>(new Set())
  const inflight = React.useRef<Set<number>>(new Set())
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = React.useCallback(async () => {
    timer.current = null
    const ids = [...pending.current].slice(0, MAX_BATCH)
    const rest = [...pending.current].slice(MAX_BATCH)
    pending.current = new Set(rest)
    if (ids.length === 0) return
    ids.forEach((id) => inflight.current.add(id))
    setChecking((prev) => {
      const n = new Set(prev)
      ids.forEach((id) => n.add(id))
      return n
    })
    try {
      const res = await nodeService.probeBatch(ids)
      const now = Date.now()
      setStatuses((prev) => {
        const next = { ...prev }
        for (const s of res.results) {
          next[s.id] = s
          fetchedAt.current.set(s.id, now)
        }
        return next
      })
    } catch {
      // Leave ids as "unknown"; a later request retries (their fetchedAt stays unset).
    } finally {
      ids.forEach((id) => inflight.current.delete(id))
      setChecking((prev) => {
        const n = new Set(prev)
        ids.forEach((id) => n.delete(id))
        return n
      })
      if (pending.current.size > 0 && timer.current == null) {
        timer.current = setTimeout(flush, DEBOUNCE_MS)
      }
    }
  }, [])

  // Queue ids for probing. Fresh (within STALE_MS) and in-flight ids are skipped
  // unless force is set (manual re-check).
  const request = React.useCallback(
    (ids: number[], force = false) => {
      const now = Date.now()
      let added = false
      for (const id of ids) {
        if (!id || inflight.current.has(id)) continue
        const at = fetchedAt.current.get(id)
        if (!force && at != null && now - at < STALE_MS) continue
        pending.current.add(id)
        added = true
      }
      if (added && timer.current == null) timer.current = setTimeout(flush, DEBOUNCE_MS)
    },
    [flush],
  )

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const byId = React.useCallback((id: number): NodeStatus | undefined => statuses[id], [statuses])
  const isChecking = React.useCallback((id: number) => checking.has(id), [checking])

  // Aggregate online/offline counts over whatever has been probed so far — the
  // stat bar annotates "已探测 N/M".
  const summary = React.useMemo(() => {
    let online = 0
    let probed = 0
    for (const s of Object.values(statuses)) {
      if (s.forbidden) continue
      probed++
      if (s.online) online++
    }
    return { online, probed }
  }, [statuses])

  return { statuses, request, byId, isChecking, summary }
}

export type UseNodeStatus = ReturnType<typeof useNodeStatus>
