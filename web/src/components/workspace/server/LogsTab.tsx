"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Download,
  FileText,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  Search as SearchIcon,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { logsService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { RunInTerminalButton } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }
type Source = "journal" | "file"

const LINE_OPTS = [200, 500, 1000, 2000]
const MAX_BUFFER = 5000

export function LogsTab({ nodeId, tabId, active }: Props) {
  const [source, setSource] = React.useState<Source>("file")
  const [ref, setRef] = React.useState("")
  const [unit, setUnit] = React.useState("")
  const [lines, setLines] = React.useState(500)
  const [filter, setFilter] = React.useState("")
  const [following, setFollowing] = React.useState(false)
  const [followLines, setFollowLines] = React.useState<string[]>([])
  const esRef = React.useRef<EventSource | null>(null)
  const preRef = React.useRef<HTMLPreElement | null>(null)

  const files = useQuery({
    queryKey: ["logs", nodeId, "files"],
    queryFn: () => logsService.files(nodeId),
    enabled: active,
    retry: false,
  })

  const effectiveRef = source === "journal" ? unit.trim() : ref

  // One-shot tail (when not following).
  const tail = useQuery({
    queryKey: ["logs", nodeId, "tail", source, effectiveRef, lines],
    queryFn: () => logsService.tail(nodeId, source, effectiveRef, lines),
    enabled: active && !following && effectiveRef !== "",
    retry: false,
  })

  const stopFollow = React.useCallback(() => {
    esRef.current?.close()
    esRef.current = null
    setFollowing(false)
  }, [])

  // SSE follow lifecycle.
  React.useEffect(() => {
    if (!following || !effectiveRef) return
    setFollowLines([])
    const url = logsService.followURL(nodeId, source, effectiveRef, Math.min(lines, 1000))
    const es = new EventSource(url)
    esRef.current = es
    es.addEventListener("line", (e) => {
      try {
        const s = JSON.parse((e as MessageEvent).data) as string
        setFollowLines((prev) => {
          const next = prev.length >= MAX_BUFFER ? prev.slice(prev.length - MAX_BUFFER + 1) : prev.slice()
          next.push(s)
          return next
        })
      } catch {
        /* ignore malformed frame */
      }
    })
    es.addEventListener("err", (e) => {
      try {
        toast.error("日志流错误", { description: JSON.parse((e as MessageEvent).data) as string })
      } catch {
        /* ignore */
      }
    })
    es.addEventListener("done", () => stopFollow())
    es.onerror = () => {
      // Network/relay drop — stop so the user can restart explicitly.
      stopFollow()
    }
    return () => {
      es.close()
      esRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, effectiveRef, source, lines, nodeId])

  React.useEffect(() => () => esRef.current?.close(), [])

  // Auto-scroll to bottom on new follow lines.
  React.useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [followLines])

  const allLines = React.useMemo(() => {
    if (following) return followLines
    return tail.data?.text ? tail.data.text.split("\n") : []
  }, [following, followLines, tail.data])

  const shown = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return allLines
    return allLines.filter((l) => l.toLowerCase().includes(q))
  }, [allLines, filter])

  const download = () => {
    const blob = new Blob([allLines.join("\n")], { type: "text/plain" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `${(effectiveRef || "log").replace(/[^\w.-]/g, "_")}.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (!active) return null

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <ScrollText className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">日志查看器</span>
          {following && <Badge variant="success" className="text-[10px]">实时</Badge>}
        </div>
        <div className="flex items-center gap-1">
          {effectiveRef && (
            <RunInTerminalButton
              tabId={tabId}
              command={source === "journal" ? `journalctl -fu ${effectiveRef}` : `tail -F ${effectiveRef}`}
              label="在终端跟随"
            />
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => (following ? undefined : tail.refetch())} disabled={following} title="刷新">
            <RefreshCw className={cn("w-3 h-3", tail.isFetching && "animate-spin")} />
          </Button>
        </div>
      </header>

      {/* Source picker */}
      <div className="px-2 py-1.5 border-b space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Select value={source} onValueChange={(v) => { stopFollow(); setSource(v as Source) }}>
            <SelectTrigger className="h-7 w-24 gap-1 text-[11px] border-border/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="file" className="text-xs">文件</SelectItem>
              <SelectItem value="journal" className="text-xs" disabled={!files.data?.has_journal}>journald</SelectItem>
            </SelectContent>
          </Select>
          {source === "file" ? (
            <Select value={ref} onValueChange={(v) => { stopFollow(); setRef(v) }}>
              <SelectTrigger className="h-7 flex-1 min-w-0 gap-1 text-[11px] border-border/60">
                <SelectValue placeholder="选择日志文件…" />
              </SelectTrigger>
              <SelectContent>
                {(files.data?.files ?? []).map((f) => (
                  <SelectItem key={f.path} value={f.path} className="text-xs">
                    <span className="font-mono">{f.path}</span>
                    <span className="text-muted-foreground ml-2">{f.size_kb}KB</span>
                  </SelectItem>
                ))}
                {(files.data?.files?.length ?? 0) === 0 && (
                  <div className="text-xs text-muted-foreground px-2 py-1.5">未发现可读日志文件</div>
                )}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={unit}
              onChange={(e) => { stopFollow(); setUnit(e.target.value) }}
              placeholder="单元名，如 nginx.service"
              className="h-7 flex-1 text-xs font-mono"
            />
          )}
          <Select value={String(lines)} onValueChange={(v) => setLines(Number(v))}>
            <SelectTrigger className="h-7 w-20 gap-1 text-[11px] border-border/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LINE_OPTS.map((n) => (
                <SelectItem key={n} value={String(n)} className="text-xs">{n} 行</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤行…" className="h-7 pl-7 text-xs" />
          </div>
          <Button
            size="sm"
            variant={following ? "default" : "outline"}
            className="h-7 text-xs"
            disabled={!effectiveRef}
            onClick={() => (following ? stopFollow() : setFollowing(true))}
          >
            {following ? <><Pause className="w-3.5 h-3.5" /> 停止</> : <><Play className="w-3.5 h-3.5" /> 实时</>}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={allLines.length === 0} onClick={download} title="下载片段">
            <Download className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Output */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-3 py-1 text-[10px] text-muted-foreground border-b flex items-center gap-2">
          <FileText className="w-3 h-3" />
          <span className="truncate font-mono">{effectiveRef || "未选择来源"}</span>
          <span className="ml-auto tabular-nums">{shown.length}{filter ? `/${allLines.length}` : ""} 行</span>
        </div>
        <pre
          ref={preRef}
          className="flex-1 overflow-auto bg-muted/40 px-3 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words"
        >
          {!effectiveRef ? (
            <span className="text-muted-foreground">选择一个文件或输入 journald 单元开始查看。</span>
          ) : !following && tail.isLoading ? (
            <span className="text-muted-foreground inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</span>
          ) : !following && tail.isError ? (
            <span className="text-destructive">{(tail.error as { message?: string })?.message || "加载失败"}</span>
          ) : shown.length === 0 ? (
            <span className="text-muted-foreground">{filter ? "无匹配行" : "（空）"}</span>
          ) : (
            shown.join("\n")
          )}
        </pre>
      </div>
    </div>
  )
}
