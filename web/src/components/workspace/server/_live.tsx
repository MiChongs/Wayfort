"use client"

import * as React from "react"
import { Activity, Cpu, HardDrive, MemoryStick } from "lucide-react"
import { buildURLFromAPI } from "@/lib/api/client"
import type { SystemSnapshot } from "@/lib/api/services"
import { useInsightsHistory } from "@/lib/hooks/use-insights-history"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { Sparkline } from "@/components/insights/sparkline"
import { StatCard } from "@/components/insights/stat-card"
import { formatBytes, usagePctTone } from "@/components/insights/format"

// SSE stream URLs for the live dock telemetry. Stable per node so the
// subscribing hooks don't re-subscribe on every render.
export function systemStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/insights/system/stream`)
}
export function processStreamURL(nodeId: number, sort: string): string {
  return buildURLFromAPI(`/nodes/${nodeId}/process/list/stream`, { sort })
}
export function perfStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/perf/snapshot/stream`)
}
export function dockerStatsStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/docker/stats/stream`)
}
export function networkStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/network/stream`)
}
export function wireguardStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/wireguard/stream`)
}
export function firewallStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/firewall/status/stream`)
}
export function firewallConntrackStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/firewall/conntrack/stream`)
}
export function firewallLogStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/firewall/logs/stream`)
}
export function firewallInstallStreamURL(nodeId: number, tool: "ufw" | "nft"): string {
  return buildURLFromAPI(`/nodes/${nodeId}/firewall/install/stream`, { tool })
}
export function fail2banInstallStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/firewall/fail2ban/install/stream`)
}
export function fail2banStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/firewall/fail2ban/stream`)
}
export function wireguardInstallStreamURL(nodeId: number): string {
  return buildURLFromAPI(`/nodes/${nodeId}/wireguard/install/stream`)
}
export function wireguardApplyStreamURL(nodeId: number, name: string, mode: "sync" | "reload"): string {
  return buildURLFromAPI(`/nodes/${nodeId}/wireguard/ifaces/${encodeURIComponent(name)}/apply/stream`, {
    mode,
  })
}

/**
 * LiveKpiStrip — a compact, in-place real-time header for ops tools. Subscribes
 * to the node's system telemetry SSE stream and renders CPU / memory / load /
 * root-disk mini-charts so the operator sees live trend without leaving the
 * current tool. `active` mirrors the dock tab being visible — the stream tears
 * down when hidden so background tabs don't keep a remote loop alive.
 */
export function LiveKpiStrip({ nodeId, active = true }: { nodeId: number; active?: boolean }) {
  const url = React.useMemo(() => systemStreamURL(nodeId), [nodeId])
  const { data, status } = useSseSnapshot<SystemSnapshot>(url, { enabled: active })

  const cpuHistory = useInsightsHistory(data, (s) => (s.cpu.usage_pct < 0 ? 0 : s.cpu.usage_pct))
  const memHistory = useInsightsHistory(data, (s) =>
    s.memory.total_kb > 0 ? (s.memory.used_kb / s.memory.total_kb) * 100 : 0,
  )

  const memPct =
    data && data.memory.total_kb > 0 ? Math.round((data.memory.used_kb / data.memory.total_kb) * 100) : 0
  const root = data?.disks.find((d) => d.mount === "/") ?? data?.disks[0]
  const load1 = data?.load_avg?.[0] ?? 0
  const loadPct = data && data.cpu.cores > 0 ? (load1 / data.cpu.cores) * 100 : 0

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <StatCard
        icon={Cpu}
        label="CPU"
        value={
          data ? (
            <span className={usagePctTone(Math.max(0, data.cpu.usage_pct))}>
              {Math.max(0, data.cpu.usage_pct).toFixed(0)}%
            </span>
          ) : (
            <Dim status={status} />
          )
        }
      >
        <Sparkline data={cpuHistory} max={100} color="var(--chart-1)" height={26} />
      </StatCard>

      <StatCard
        icon={MemoryStick}
        label="内存"
        value={data ? <span className={usagePctTone(memPct)}>{memPct}%</span> : <Dim status={status} />}
        hint={data ? `${formatBytes(data.memory.used_kb)} / ${formatBytes(data.memory.total_kb)}` : undefined}
      >
        <Sparkline data={memHistory} max={100} color="var(--chart-2)" height={26} />
      </StatCard>

      <StatCard
        icon={HardDrive}
        label="根分区"
        value={root ? <span className={usagePctTone(root.used_pct)}>{root.used_pct}%</span> : <Dim status={status} />}
        hint={root ? root.mount : undefined}
      />

      <StatCard
        icon={Activity}
        label="负载 1m"
        value={data ? <span className={usagePctTone(loadPct)}>{load1.toFixed(2)}</span> : <Dim status={status} />}
        hint={data ? `每核 ${loadPct.toFixed(0)}%` : undefined}
      />
    </div>
  )
}

function Dim({ status }: { status: string }) {
  return <span className="text-base text-muted-foreground">{status === "error" ? "—" : "采集中…"}</span>
}
