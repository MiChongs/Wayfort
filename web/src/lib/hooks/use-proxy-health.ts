"use client"

import * as React from "react"
import { proxyService } from "@/lib/api/services"
import { useSseSnapshot, type SseStatus } from "@/lib/hooks/use-sse-snapshot"
import type { ProxyHealth, ProxyHealthSnapshot } from "@/lib/api/types"

export interface ProxyHealthView {
  /** Latest verdict for one proxy, or undefined if never probed. */
  byId: (id: number) => ProxyHealth | undefined
  snapshot: ProxyHealthSnapshot | undefined
  status: SseStatus
  sampledAt: number | null
}

/**
 * useProxyHealth subscribes to the aggregate proxy-health SSE stream — one
 * connection that carries every proxy's latest probe verdict keyed by id. Wrap a
 * tree in ProxyHealthProvider and read it via useProxyHealthCtx so rows / hops /
 * canvas nodes share this single subscription instead of each opening their own.
 */
export function useProxyHealth(opts?: { enabled?: boolean }): ProxyHealthView {
  const url = React.useMemo(() => proxyService.healthStreamURL(), [])
  const { data, status, lastAt } = useSseSnapshot<ProxyHealthSnapshot>(url, {
    enabled: opts?.enabled ?? true,
  })
  const byId = React.useCallback((id: number) => data?.proxies?.[id], [data])
  return { byId, snapshot: data, status, sampledAt: lastAt }
}
