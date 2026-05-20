"use client"

import * as React from "react"
import { Activity, Cpu, HardDrive, MemoryStick, Server, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { useInsightsHistory } from "@/lib/hooks/use-insights-history"
import type {
  InsightsProcess,
  ProcessList,
  SystemSnapshot,
} from "@/lib/api/services"
import { Sparkline } from "./sparkline"
import { StatCard } from "./stat-card"
import {
  formatBytes,
  formatUptime,
  usagePctBg,
  usagePctTone,
} from "./format"

export interface OverviewTabProps {
  system?: SystemSnapshot
  processes?: ProcessList
  onJumpToProcesses(sort: "cpu" | "mem"): void
}

export function OverviewTab({ system, processes, onJumpToProcesses }: OverviewTabProps) {
  const cpuHistory = useInsightsHistory(
    system,
    (s) => (s.cpu.usage_pct < 0 ? 0 : s.cpu.usage_pct),
  )
  const memHistory = useInsightsHistory(system, (s) =>
    s.memory.total_kb > 0
      ? (s.memory.used_kb / s.memory.total_kb) * 100
      : 0,
  )

  if (!system) {
    return (
      <div className="p-4 text-sm text-muted-foreground">采集中…</div>
    )
  }

  const memUsedPct =
    system.memory.total_kb > 0
      ? Math.round((system.memory.used_kb / system.memory.total_kb) * 100)
      : 0
  const swapPct =
    system.memory.swap_total_kb > 0
      ? Math.round((system.memory.swap_used_kb / system.memory.swap_total_kb) * 100)
      : 0
  const rootDisk =
    system.disks.find((d) => d.mount === "/") ?? system.disks[0]
  const rootPct = rootDisk?.used_pct ?? 0

  const topByCPU = (processes?.processes ?? [])
    .slice()
    .sort((a, b) => b.cpu_pct - a.cpu_pct)
    .slice(0, 5)
  const topByMem = (processes?.processes ?? [])
    .slice()
    .sort((a, b) => b.mem_pct - a.mem_pct)
    .slice(0, 5)

  return (
    <div className="p-3 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          icon={Cpu}
          label="CPU"
          value={
            system.cpu.usage_pct < 0
              ? <span className="text-muted-foreground text-base">采集中…</span>
              : <span className={usagePctTone(system.cpu.usage_pct)}>
                  {system.cpu.usage_pct.toFixed(1)}%
                </span>
          }
          hint={`${system.cpu.cores} 核 · load ${system.load_avg[0].toFixed(2)} / ${system.load_avg[1].toFixed(2)} / ${system.load_avg[2].toFixed(2)}`}
        >
          <Sparkline data={cpuHistory} max={100} />
        </StatCard>
        <StatCard
          icon={MemoryStick}
          label="内存"
          value={<span className={usagePctTone(memUsedPct)}>{memUsedPct}%</span>}
          hint={`${formatBytes(system.memory.used_kb)} / ${formatBytes(system.memory.total_kb)}`}
        >
          <Sparkline data={memHistory} max={100} />
        </StatCard>
        <StatCard
          icon={HardDrive}
          label="根分区"
          value={<span className={usagePctTone(rootPct)}>{rootPct}%</span>}
          hint={
            rootDisk
              ? `${formatBytes(rootDisk.used_kb)} / ${formatBytes(rootDisk.total_kb)} · ${rootDisk.mount}`
              : "—"
          }
        />
        <StatCard
          icon={Activity}
          label="负载 (1m)"
          value={system.load_avg[0].toFixed(2)}
          hint={`5m ${system.load_avg[1].toFixed(2)} · 15m ${system.load_avg[2].toFixed(2)}`}
        />
      </div>

      {system.memory.swap_total_kb > 0 && (
        <Card className="py-3">
          <CardContent className="px-3 py-0 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">SWAP</span>
              <span className="tabular-nums">
                {formatBytes(system.memory.swap_used_kb)} / {formatBytes(system.memory.swap_total_kb)} ({swapPct}%)
              </span>
            </div>
            <Progress
              value={Math.min(100, swapPct)}
              className="h-1.5"
              indicatorClassName={usagePctBg(swapPct)}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-xs font-medium flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5" />
            主机信息
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-0 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
          <Row k="主机名" v={system.host.hostname || "—"} />
          <Row k="发行版" v={system.host.distro || system.host.os} />
          <Row k="内核" v={system.host.kernel || "—"} />
          <Row k="架构" v={system.host.arch || "—"} />
          <Row k="开机时长" v={formatUptime(system.uptime_sec)} />
          <Row
            k="登录用户"
            v={
              <span className="inline-flex items-center gap-1">
                <Users className="w-3 h-3 text-muted-foreground" />
                {system.logged_in_users}
              </span>
            }
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <TopProcessList
          title="Top 5 CPU"
          procs={topByCPU}
          metric="cpu_pct"
          onJump={() => onJumpToProcesses("cpu")}
        />
        <TopProcessList
          title="Top 5 内存"
          procs={topByMem}
          metric="mem_pct"
          onJump={() => onJumpToProcesses("mem")}
        />
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <div className="text-muted-foreground">{k}</div>
      <div className="font-mono truncate">{v}</div>
    </>
  )
}

function TopProcessList({
  title,
  procs,
  metric,
  onJump,
}: {
  title: string
  procs: InsightsProcess[]
  metric: "cpu_pct" | "mem_pct"
  onJump: () => void
}) {
  return (
    <Card>
      <CardHeader className="py-2 px-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-xs font-medium">{title}</CardTitle>
        <button
          type="button"
          onClick={onJump}
          className="text-[10px] text-primary hover:underline"
        >
          查看全部
        </button>
      </CardHeader>
      <CardContent className="px-2 pb-2 pt-0 space-y-0.5">
        {procs.length === 0 ? (
          <div className="text-[11px] text-muted-foreground px-1 py-1.5">无数据</div>
        ) : (
          procs.map((p) => (
            <div
              key={p.pid}
              className="flex items-center gap-2 text-[11px] px-1 py-0.5 rounded hover:bg-muted/60"
            >
              <Badge variant="outline" className="font-mono text-[10px] px-1 h-4 shrink-0">
                {p[metric].toFixed(1)}%
              </Badge>
              <span className="truncate flex-1">{p.comm}</span>
              <span className="text-muted-foreground tabular-nums shrink-0">#{p.pid}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
