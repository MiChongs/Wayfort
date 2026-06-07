"use client"

import * as React from "react"
import {
  Activity,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Server,
  Thermometer,
  UsersRound,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { useInsightsHistory } from "@/lib/hooks/use-insights-history"
import { cn } from "@/lib/utils"
import type {
  InsightsLoginUser,
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
    return <div className="p-4 text-sm text-muted-foreground">采集中…</div>
  }

  const memUsedPct =
    system.memory.total_kb > 0
      ? Math.round((system.memory.used_kb / system.memory.total_kb) * 100)
      : 0
  const swapPct =
    system.memory.swap_total_kb > 0
      ? Math.round((system.memory.swap_used_kb / system.memory.swap_total_kb) * 100)
      : 0
  const rootDisk = system.disks.find((d) => d.mount === "/") ?? system.disks[0]
  const rootPct = rootDisk?.used_pct ?? 0
  const load1 = system.load_avg[0]
  // Load relative to core count — the only honest way to read a load average.
  const loadPct = system.cpu.cores > 0 ? (load1 / system.cpu.cores) * 100 : 0

  const cpu = system.cpu
  const hasBreakdown = cpu.user_pct >= 0
  const cpuHint = [
    `${cpu.cores} 核`,
    cpu.mhz ? `${(cpu.mhz / 1000).toFixed(2)}GHz` : "",
    cpu.temp_c ? `${Math.round(cpu.temp_c)}°C` : "",
  ]
    .filter(Boolean)
    .join(" · ")

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
            cpu.usage_pct < 0 ? (
              <span className="text-muted-foreground text-base">采集中…</span>
            ) : (
              <span className={usagePctTone(cpu.usage_pct)}>
                {cpu.usage_pct.toFixed(1)}%
              </span>
            )
          }
          hint={cpuHint}
        >
          <Sparkline data={cpuHistory} max={100} />
          {hasBreakdown && (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1 text-[10px] tabular-nums">
              <Legend tone="bg-success" label="用户" value={cpu.user_pct} />
              <Legend tone="bg-warning" label="系统" value={cpu.system_pct} />
              <Legend tone="bg-primary" label="IO 等待" value={cpu.iowait_pct} />
              {cpu.steal_pct > 0 && (
                <Legend tone="bg-destructive" label="被抢占" value={cpu.steal_pct} />
              )}
            </div>
          )}
        </StatCard>
        <StatCard
          icon={MemoryStick}
          label="内存"
          value={<span className={usagePctTone(memUsedPct)}>{memUsedPct}%</span>}
          hint={`${formatBytes(system.memory.used_kb)} / ${formatBytes(system.memory.total_kb)}`}
        >
          <Sparkline data={memHistory} max={100} />
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1 text-[10px] tabular-nums text-muted-foreground">
            <span>可用 {formatBytes(system.memory.available_kb)}</span>
            <span>缓存 {formatBytes(system.memory.buff_cache_kb)}</span>
          </div>
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
          value={<span className={usagePctTone(loadPct)}>{load1.toFixed(2)}</span>}
          hint={`每核 ${(loadPct).toFixed(0)}% · 5m ${system.load_avg[1].toFixed(2)} · 15m ${system.load_avg[2].toFixed(2)}`}
        />
      </div>

      {system.memory.swap_total_kb > 0 && (
        <MeterCard
          label="SWAP"
          pct={swapPct}
          right={`${formatBytes(system.memory.swap_used_kb)} / ${formatBytes(system.memory.swap_total_kb)}`}
        />
      )}

      {cpu.per_core && cpu.per_core.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-xs font-medium flex items-center gap-1.5">
              <Gauge className="w-3.5 h-3.5" />
              每核负载
            </CardTitle>
            <span className="text-[10px] text-muted-foreground">{cpu.per_core.length} 逻辑核</span>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            <PerCoreMeters cores={cpu.per_core} />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2">
        <ProcCensusCard system={system} />
        <Card>
          <CardHeader className="py-2 px-3 space-y-0">
            <CardTitle className="text-xs font-medium flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5" />
              主机
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0 space-y-1.5 text-[11px]">
            <Row k="主机名" v={system.host.hostname || "—"} />
            <Row k="系统" v={system.host.distro || system.host.os} />
            <Row k="内核" v={system.host.kernel || "—"} />
            <Row k="架构" v={system.host.arch || "—"} />
            <Row k="开机" v={formatUptime(system.uptime_sec)} />
          </CardContent>
        </Card>
      </div>

      {system.temps && system.temps.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3 space-y-0">
            <CardTitle className="text-xs font-medium flex items-center gap-1.5">
              <Thermometer className="w-3.5 h-3.5" />
              温度
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {system.temps.map((t) => (
              <div key={t.label} className="flex items-center justify-between gap-2 min-w-0">
                <span className="text-muted-foreground truncate" title={t.label}>{t.label}</span>
                <span className={cn("tabular-nums shrink-0", tempTone(t.temp_c))}>
                  {Math.round(t.temp_c)}°C
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {system.sessions && system.sessions.length > 0 && (
        <SessionsCard sessions={system.sessions} />
      )}

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

function Legend({ tone, label, value }: { tone: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span className={cn("inline-block w-1.5 h-1.5 rounded-full", tone)} />
      {label} <span className="text-foreground">{value.toFixed(0)}%</span>
    </span>
  )
}

function MeterCard({ label, pct, right }: { label: string; pct: number; right: string }) {
  return (
    <Card className="py-3">
      <CardContent className="px-3 py-0 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums">
            {right} ({pct}%)
          </span>
        </div>
        <Progress value={Math.min(100, pct)} className="h-1.5" indicatorClassName={usagePctBg(pct)} />
      </CardContent>
    </Card>
  )
}

// PerCoreMeters renders one vertical fill per logical core, wrapping. Color and
// height both encode busy% so a glance reads the whole CPU at once.
function PerCoreMeters({ cores }: { cores: number[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {cores.map((pct, i) => {
        const clamped = Math.max(0, Math.min(100, pct))
        return (
          <div
            key={i}
            className="relative w-2.5 h-9 rounded-full bg-muted overflow-hidden"
            title={`核 ${i} · ${clamped.toFixed(0)}%`}
          >
            <div
              className={cn("absolute inset-x-0 bottom-0 rounded-full transition-[height]", usagePctBg(clamped))}
              style={{ height: `${Math.max(4, clamped)}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}

function ProcCensusCard({ system }: { system: SystemSnapshot }) {
  const p = system.procs
  return (
    <Card>
      <CardHeader className="py-2 px-3 space-y-0">
        <CardTitle className="text-xs font-medium flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5" />
          进程 · {p.total}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-0 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <Census tone="bg-success" k="运行" v={p.running} />
        <Census tone="bg-muted-foreground" k="睡眠" v={p.sleeping} />
        <Census tone="bg-warning" k="停止" v={p.stopped} />
        <Census tone={p.zombie > 0 ? "bg-destructive" : "bg-muted-foreground"} k="僵尸" v={p.zombie} />
        {p.threads ? (
          <div className="col-span-2 flex items-center justify-between text-muted-foreground pt-0.5">
            <span>线程总数</span>
            <span className="tabular-nums text-foreground">{p.threads}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Census({ tone, k, v }: { tone: string; k: string; v: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full", tone)} />
        {k}
      </span>
      <span className="tabular-nums">{v}</span>
    </div>
  )
}

function SessionsCard({ sessions }: { sessions: InsightsLoginUser[] }) {
  return (
    <Card>
      <CardHeader className="py-2 px-3 space-y-0">
        <CardTitle className="text-xs font-medium flex items-center gap-1.5">
          <UsersRound className="w-3.5 h-3.5" />
          登录会话 · {sessions.length}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-2 pt-0">
        <div className="max-h-32 overflow-auto -mx-1">
          <table className="w-full text-[11px]">
            <tbody className="divide-y divide-border/40">
              {sessions.map((s, i) => (
                <tr key={`${s.user}:${s.tty}:${i}`} className="hover:bg-muted/50">
                  <td className="px-1 py-1 font-medium truncate max-w-[5rem]" title={s.user}>{s.user}</td>
                  <td className="px-1 py-1 font-mono text-muted-foreground truncate max-w-[4rem]" title={s.tty}>{s.tty}</td>
                  <td className="px-1 py-1 font-mono text-muted-foreground truncate" title={s.from || ""}>
                    {s.from || "本地"}
                  </td>
                  <td className="px-1 py-1 text-muted-foreground tabular-nums text-right whitespace-nowrap">
                    {s.login || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 min-w-0">
      <span className="text-muted-foreground shrink-0">{k}</span>
      <span className="font-mono truncate text-right" title={typeof v === "string" ? v : undefined}>
        {v}
      </span>
    </div>
  )
}

// Temperature thresholds — sage under 60, amber 60-80, brick above.
function tempTone(c: number): string {
  if (c >= 80) return "text-destructive"
  if (c >= 60) return "text-warning"
  return "text-success"
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
