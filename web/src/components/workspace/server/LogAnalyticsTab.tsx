"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Loader2, ScrollText, Search as SearchIcon } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { VirtualTable } from "@/components/common/virtual-table"
import { logAnalyticsService, type LogLevels, type LogMatch } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }
type Source = "files" | "journal"

const LEVEL_TONE: Record<string, string> = {
  error: "text-destructive",
  warn: "text-warning",
  info: "text-[#4f9d8f] dark:text-[#5db8a6]",
  other: "text-muted-foreground",
}
const LEVEL_BG: Record<string, string> = {
  error: "bg-destructive",
  warn: "bg-warning",
  info: "bg-[#5db8a6]",
  other: "bg-muted-foreground",
}

export function LogAnalyticsTab({ nodeId, active }: Props) {
  const [source, setSource] = React.useState<Source>("files")
  const [pattern, setPattern] = React.useState("")
  const [path, setPath] = React.useState("/var/log")
  const [unit, setUnit] = React.useState("")

  const search = useMutation({
    mutationFn: () => logAnalyticsService.search(nodeId, { source, pattern: pattern.trim(), path, unit, lines: 20000 }),
    onError: (e: ApiError) => toast.error("检索失败", { description: codeOf(e) === "unreachable" ? "节点 SSH 不可达。" : e?.message }),
  })
  const data = search.data
  const matches = data?.matches ?? []
  const run = () => { if (pattern.trim()) search.mutate() }

  if (!active) return null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b bg-card px-3 py-2">
        <ScrollText className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-xs font-medium">日志分析</span>
      </header>

      <div className="space-y-1.5 border-b p-2">
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant={source === "files" ? "default" : "outline"} className="h-7 shrink-0 text-[11px]" onClick={() => setSource("files")}>文件</Button>
          <Button size="sm" variant={source === "journal" ? "default" : "outline"} className="h-7 shrink-0 text-[11px]" onClick={() => setSource("journal")}>journald</Button>
          {source === "files" ? (
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/var/log" className="h-7 min-w-0 flex-1 text-xs font-mono" />
          ) : (
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="单元(可选)，如 nginx" className="h-7 min-w-0 flex-1 text-xs font-mono" />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") run() }} placeholder="正则/关键字，如 error|timeout" className="h-7 pl-7 text-xs font-mono" />
          </div>
          <Button size="sm" className="h-7 shrink-0 text-xs" disabled={!pattern.trim() || search.isPending} onClick={run}>
            {search.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "检索"}
          </Button>
        </div>
        {data && <Histogram levels={data.levels} total={matches.length} truncated={data.truncated} />}
      </div>

      <div className="min-h-0 flex-1">
        {search.isPending ? (
          <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 检索中…</div>
        ) : !data ? (
          <div className="p-6 text-center text-xs text-muted-foreground">输入关键字检索 {source === "files" ? "日志文件" : "journald"}，回车或点「检索」。</div>
        ) : (
          <VirtualTable
            rows={matches}
            empty="无匹配"
            header={
              <>
                <th className="px-2 py-1.5 text-left">来源</th>
                <th className="w-10 px-2 py-1.5 text-right">行</th>
                <th className="px-2 py-1.5 text-left">内容</th>
              </>
            }
            renderRow={(mt: LogMatch) => (
              <>
                <td className="max-w-[7rem] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground" title={mt.source}>{mt.source.split("/").pop()}</td>
                <td className="px-2 py-1 text-right font-mono text-[10px] text-muted-foreground tabular-nums">{mt.line || ""}</td>
                <td className={cn("px-2 py-1 font-mono text-[10px]", LEVEL_TONE[mt.level])} title={mt.text}>
                  <span className="line-clamp-2 break-all">{mt.text}</span>
                </td>
              </>
            )}
          />
        )}
      </div>
    </div>
  )
}

function Histogram({ levels, total, truncated }: { levels: LogLevels; total: number; truncated: boolean }) {
  const max = Math.max(1, levels.error, levels.warn, levels.info, levels.other)
  const bars: { k: keyof LogLevels; label: string }[] = [
    { k: "error", label: "错误" },
    { k: "warn", label: "警告" },
    { k: "info", label: "信息" },
    { k: "other", label: "其他" },
  ]
  return (
    <div className="space-y-1 pt-1">
      <div className="text-[10px] text-muted-foreground">{total} 条匹配{truncated ? "（已截断至上限）" : ""}</div>
      <div className="grid grid-cols-4 gap-1.5">
        {bars.map((b) => (
          <div key={b.k} className="space-y-0.5">
            <div className="flex h-8 items-end overflow-hidden rounded bg-muted/40">
              <div className={cn("w-full rounded-t transition-[height]", LEVEL_BG[b.k])} style={{ height: `${(levels[b.k] / max) * 100}%` }} />
            </div>
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-muted-foreground">{b.label}</span>
              <span className={cn("tabular-nums", LEVEL_TONE[b.k])}>{levels[b.k]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
