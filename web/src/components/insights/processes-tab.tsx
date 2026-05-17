"use client"

import * as React from "react"
import { ChevronDown, ChevronRight, Search as SearchIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import type { InsightsProcess, ProcessList, ProcessSort } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { formatBytes } from "./format"

export interface ProcessesTabProps {
  data?: ProcessList
  sort: ProcessSort
  onSortChange(s: ProcessSort): void
}

const COLUMNS: Array<{
  key: ProcessSort | "comm" | "args" | "user"
  label: string
  className?: string
  sortable: boolean
}> = [
  { key: "pid", label: "PID", className: "w-16", sortable: true },
  { key: "user", label: "USER", className: "w-20", sortable: false },
  { key: "cpu", label: "%CPU", className: "w-16 text-right", sortable: true },
  { key: "mem", label: "%MEM", className: "w-16 text-right", sortable: true },
  { key: "rss", label: "RSS", className: "w-20 text-right", sortable: true },
  { key: "comm", label: "命令", className: "flex-1 min-w-0", sortable: false },
]

export function ProcessesTab({ data, sort, onSortChange }: ProcessesTabProps) {
  const [filter, setFilter] = React.useState("")
  const [expanded, setExpanded] = React.useState<number | null>(null)

  const filtered = React.useMemo(() => {
    const list = data?.processes ?? []
    if (!filter) return list
    const q = filter.toLowerCase()
    return list.filter(
      (p) =>
        p.comm.toLowerCase().includes(q) ||
        p.args.toLowerCase().includes(q) ||
        p.user.toLowerCase().includes(q),
    )
  }, [data, filter])

  if (!data) {
    return <div className="p-4 text-sm text-muted-foreground">采集中…</div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-border/60 flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤 user / 命令 / 参数…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Badge variant="outline" className="text-[10px]">
          共 {data.total}
        </Badge>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="sticky top-0 bg-background border-b border-border/60">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-2 py-1.5 text-left text-muted-foreground font-medium",
                    c.className,
                    c.sortable && "cursor-pointer hover:text-foreground",
                    sort === c.key && c.sortable && "text-foreground",
                  )}
                  onClick={() => {
                    if (c.sortable) onSortChange(c.key as ProcessSort)
                  }}
                >
                  {c.label}
                  {sort === c.key && c.sortable && (
                    <span className="ml-1 text-primary">↓</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="py-6 text-center text-muted-foreground"
                >
                  无匹配进程
                </td>
              </tr>
            ) : (
              filtered.map((p) => (
                <ProcessRow
                  key={p.pid}
                  proc={p}
                  expanded={expanded === p.pid}
                  onToggle={() => setExpanded((cur) => (cur === p.pid ? null : p.pid))}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ProcessRow({
  proc,
  expanded,
  onToggle,
}: {
  proc: InsightsProcess
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className="border-b border-border/30 hover:bg-muted/60 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-2 py-1 tabular-nums flex items-center gap-0.5">
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          )}
          {proc.pid}
        </td>
        <td className="px-2 py-1 truncate max-w-[80px]" title={proc.user}>
          {proc.user}
        </td>
        <td className="px-2 py-1 tabular-nums text-right">
          {proc.cpu_pct.toFixed(1)}
        </td>
        <td className="px-2 py-1 tabular-nums text-right">
          {proc.mem_pct.toFixed(1)}
        </td>
        <td className="px-2 py-1 tabular-nums text-right text-muted-foreground">
          {formatBytes(proc.rss_kb)}
        </td>
        <td className="px-2 py-1 truncate" title={proc.args || proc.comm}>
          {proc.comm}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/30 bg-muted/30">
          <td colSpan={6} className="px-2 py-1.5 text-[10px]">
            <div className="grid grid-cols-[80px_1fr] gap-x-2 gap-y-0.5">
              <span className="text-muted-foreground">PPID</span>
              <span className="tabular-nums">{proc.ppid}</span>
              <span className="text-muted-foreground">STATE</span>
              <span>{proc.state}</span>
              <span className="text-muted-foreground">完整参数</span>
              <span className="break-all whitespace-pre-wrap">
                {proc.args || proc.comm}
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
