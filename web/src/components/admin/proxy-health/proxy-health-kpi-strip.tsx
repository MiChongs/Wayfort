"use client"

import * as React from "react"
import { Activity, Cable, CircleSlash, Gauge, Wifi } from "lucide-react"
import { StatCard } from "@/components/insights/stat-card"
import type { ProxyHealthState, ProxyMetricsSnapshot } from "@/lib/api/types"
import { useProxyHealthCtx } from "./health-context"

/**
 * ProxyHealthKpiStrip — the always-on header of the proxy-chain center. Mirrors
 * the node-scoped LiveKpiStrip pattern but reads the aggregate proxy-health
 * context plus an optional metrics snapshot, surfacing online/degraded/down
 * counts, live active connections and aggregate success rate.
 */
export function ProxyHealthKpiStrip({ metrics }: { metrics?: ProxyMetricsSnapshot }) {
  const { snapshot } = useProxyHealthCtx()

  const counts = React.useMemo(() => {
    const c: Record<ProxyHealthState, number> & { total: number } = {
      online: 0,
      degraded: 0,
      down: 0,
      unknown: 0,
      total: 0,
    }
    const ps = snapshot?.proxies ?? {}
    for (const k of Object.keys(ps)) {
      const h = ps[Number(k)]
      c.total++
      c[h.state] = (c[h.state] ?? 0) + 1
    }
    return c
  }, [snapshot])

  const agg = metrics?.aggregate

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
      <StatCard icon={Wifi} label="在线" tone="success" value={counts.online} hint={`共 ${counts.total} 个代理`} />
      <StatCard
        icon={Activity}
        label="降级"
        tone={counts.degraded > 0 ? "warning" : "default"}
        value={counts.degraded}
      />
      <StatCard
        icon={CircleSlash}
        label="离线"
        tone={counts.down > 0 ? "danger" : "default"}
        value={counts.down}
      />
      <StatCard
        icon={Cable}
        label="活动连接"
        value={agg ? agg.active_conns : "—"}
        hint={agg ? `累计拨号 ${agg.total_dials}` : undefined}
      />
      <StatCard
        icon={Gauge}
        label="成功率"
        value={agg ? `${Math.round(agg.success_rate * 100)}%` : "—"}
        hint={agg ? `失败 ${agg.failures}` : undefined}
      />
    </div>
  )
}
