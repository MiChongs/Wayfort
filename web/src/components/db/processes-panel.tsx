"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Activity, Pause, RefreshCw, Square, Users } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { dbService } from "@/lib/api/services"
import type { DBProcessInfo } from "@/lib/api/types"
import { cn } from "@/lib/utils"

type Props = {
  nodeId: number
  database?: string
  className?: string
}

// ProcessesPanel — running-queries / sessions view. Polls pg_stat_activity
// (PG) or information_schema.PROCESSLIST (MySQL) on a fixed interval.
// Each row exposes a Kill button which routes through the approval
// gate (sql_exec) the same way row edits do.
export function ProcessesPanel({ nodeId, database, className }: Props) {
  const qc = useQueryClient()
  const [paused, setPaused] = React.useState(false)
  const [filter, setFilter] = React.useState("")

  const q = useQuery({
    queryKey: ["db.processes", nodeId, database],
    queryFn: () => dbService.processes(nodeId, database),
    refetchInterval: paused ? false : 5000,
    placeholderData: (prev) => prev,
  })

  const kill = useMutation({
    mutationFn: (pid: number) => dbService.kill(nodeId, pid, database),
    onSuccess: (r, pid) => {
      toast.success(r.cancelled ? `已取消 PID ${pid}` : `已向 PID ${pid} 发取消信号`)
      qc.invalidateQueries({ queryKey: ["db.processes", nodeId, database] })
    },
    onError: (e: { message?: string }) => toast.error(e.message || "Kill 失败"),
  })

  const filtered = React.useMemo(() => {
    const list = q.data?.processes ?? []
    const needle = filter.trim().toLowerCase()
    if (!needle) return list
    return list.filter((p) =>
      [p.username, p.client_addr, p.database, p.state, p.query, p.application]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    )
  }, [q.data, filter])

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <div className="border-b px-3 py-2 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <Activity className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium">进程</span>
          <Badge variant="outline" className="font-mono tabular-nums">
            {filtered.length}/{q.data?.processes.length ?? 0}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤 SQL / 用户 / 状态"
            className="h-7 text-xs w-56"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1 text-xs"
            onClick={() => setPaused((v) => !v)}
            title={paused ? "继续自动刷新" : "暂停自动刷新"}
          >
            <Pause className="w-3.5 h-3.5" />
            {paused ? "已暂停" : "5s"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => q.refetch()}
            title="立即刷新"
          >
            <RefreshCw className={q.isFetching ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"} />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card/95 backdrop-blur border-b">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium w-16">PID</th>
              <th className="px-2 py-1.5 text-left font-medium w-28">用户</th>
              <th className="px-2 py-1.5 text-left font-medium w-32">客户端</th>
              <th className="px-2 py-1.5 text-left font-medium w-24">数据库</th>
              <th className="px-2 py-1.5 text-left font-medium w-24">状态</th>
              <th className="px-2 py-1.5 text-right font-medium w-16">耗时</th>
              <th className="px-2 py-1.5 text-left font-medium">SQL</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <ProcessRow key={p.pid} p={p} onKill={() => kill.mutate(p.pid)} />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  <Users className="w-4 h-4 inline mr-1" />
                  没有匹配的会话
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  )
}

function ProcessRow({ p, onKill }: { p: DBProcessInfo; onKill: () => void }) {
  const stateTone =
    p.state === "active" || p.state === "Query"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200"
      : p.state === "idle in transaction" || p.state === "idle in transaction (aborted)"
      ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200"
      : "bg-muted text-muted-foreground"
  const elapsed = p.elapsed_sec ?? 0
  const elapsedTone =
    elapsed > 60 ? "text-destructive" : elapsed > 5 ? "text-amber-600" : "text-muted-foreground"
  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/40 group align-top">
      <td className="px-2 py-1 font-mono tabular-nums">{p.pid}</td>
      <td className="px-2 py-1 truncate">{p.username || "—"}</td>
      <td className="px-2 py-1 font-mono text-[10px] truncate">{p.client_addr || "—"}</td>
      <td className="px-2 py-1 truncate">{p.database || "—"}</td>
      <td className="px-2 py-1">
        {p.state ? <span className={cn("text-[10px] px-1.5 py-0.5 rounded", stateTone)}>{p.state}</span> : "—"}
      </td>
      <td className={cn("px-2 py-1 text-right font-mono tabular-nums", elapsedTone)}>
        {elapsed.toFixed(1)}s
      </td>
      <td className="px-2 py-1 font-mono text-[11px]">
        <div className="max-w-2xl break-words whitespace-pre-wrap">
          {p.query?.trim() || <span className="text-muted-foreground italic">(无 SQL)</span>}
        </div>
        {p.wait_event && (
          <div className="text-[9px] text-muted-foreground mt-0.5">等待: {p.wait_event}</div>
        )}
      </td>
      <td className="text-right opacity-0 group-hover:opacity-100 transition-opacity pr-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 gap-1 text-xs hover:text-destructive"
          onClick={() => {
            if (!confirm(`KILL PID ${p.pid}?`)) return
            onKill()
          }}
        >
          <Square className="w-3 h-3" /> Kill
        </Button>
      </td>
    </tr>
  )
}
