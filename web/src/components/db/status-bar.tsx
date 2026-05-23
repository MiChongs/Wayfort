"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, Clock, Database, HardDrive, Server, Table as TableIcon, Users } from "lucide-react"
import { dbService } from "@/lib/api/services"

type Props = {
  nodeId: number
  database?: string
  className?: string
}

// StatusBar — slim footer that surfaces per-database health: total
// size, table count, connections, server version, uptime. Polls every
// 30s so an operator notices a connection spike or a sudden size jump
// without manual refresh. Errors degrade silently (missing fields stay
// blank); the bar is informational, not blocking.
export function StatusBar({ nodeId, database, className }: Props) {
  const stats = useQuery({
    queryKey: ["db.dbstats", nodeId, database],
    queryFn: () => dbService.databaseStats(nodeId, database),
    enabled: !!database,
    refetchInterval: 30_000,
    retry: false,
  })

  if (!database) return null
  const s = stats.data

  return (
    <div
      className={`flex items-center gap-3 px-3 py-1 border-t bg-muted/20 text-[10px] text-muted-foreground overflow-x-auto whitespace-nowrap ${className ?? ""}`}
    >
      <Pill icon={<Database className="w-3 h-3" />} label={database} />
      <Sep />
      <Pill
        icon={<HardDrive className="w-3 h-3" />}
        label={s ? formatBytes(s.size_bytes) : "—"}
        title="数据库总占用"
      />
      <Sep />
      <Pill
        icon={<TableIcon className="w-3 h-3" />}
        label={s ? `${s.table_count} 对象` : "—"}
        title="表 + 视图 + 物化视图"
      />
      <Sep />
      <Pill
        icon={<Users className="w-3 h-3" />}
        label={s ? `${s.connections} 连接` : "—"}
        title="可见的会话数；权限受限的角色只看到自己"
      />
      {s?.uptime_seconds ? (
        <>
          <Sep />
          <Pill
            icon={<Clock className="w-3 h-3" />}
            label={formatUptime(s.uptime_seconds)}
            title="服务端启动至今"
          />
        </>
      ) : null}
      {s?.version && (
        <>
          <Sep />
          <Pill
            icon={<Server className="w-3 h-3" />}
            label={truncate(s.version, 60)}
            title={s.version}
            mono
          />
        </>
      )}
      <span className="ml-auto inline-flex items-center gap-1 shrink-0">
        <Activity
          className={`w-3 h-3 ${stats.isFetching ? "animate-pulse text-emerald-500" : "text-muted-foreground/50"}`}
        />
        {stats.isFetching ? "刷新中" : stats.data ? "已同步" : "等待"}
      </span>
    </div>
  )
}

function Pill({
  icon, label, title, mono,
}: { icon: React.ReactNode; label: string; title?: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 shrink-0" title={title}>
      {icon}
      <span className={mono ? "font-mono" : ""}>{label}</span>
    </span>
  )
}

function Sep() { return <span className="opacity-30">·</span> }

function formatBytes(n: number): string {
  if (n <= 0) return "0 B"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n < 1024 * 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  return `${(n / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB`
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}
