"use client"

import * as React from "react"
import { Virtuoso } from "react-virtuoso"
import { Download, Loader2, Pause, Play, Trash } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CopyButton } from "@/components/common/copy-button"
import { streamSSE } from "@/lib/sse/eventsource"
import { cn } from "@/lib/utils"
import { firewallLogStreamURL } from "../_live"
import { downloadText, SectionHeader } from "./shared"

const MAX_LINES = 5000

export function FwLogsView({ nodeId, active }: { nodeId: number; active: boolean }) {
  const [lines, setLines] = React.useState<string[]>([])
  const [paused, setPaused] = React.useState(false)
  const [filter, setFilter] = React.useState("")
  const [live, setLive] = React.useState(false)
  const pausedRef = React.useRef(false)
  pausedRef.current = paused

  React.useEffect(() => {
    if (!active) return
    const ctrl = new AbortController()
    setLive(true)
    const run = async () => {
      try {
        await streamSSE(firewallLogStreamURL(nodeId), { method: "GET", signal: ctrl.signal }, (kind, payload) => {
          if (kind === "line" && !pausedRef.current) {
            const text = typeof payload === "string" ? payload : JSON.stringify(payload)
            setLines((prev) => {
              const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice()
              next.push(text)
              return next
            })
          }
        })
      } catch {
        /* aborted / ended */
      }
      setLive(false)
    }
    void run()
    return () => ctrl.abort()
  }, [active, nodeId])

  const shown = React.useMemo(() => {
    if (!filter.trim()) return lines
    const n = filter.toLowerCase()
    return lines.filter((l) => l.toLowerCase().includes(n))
  }, [lines, filter])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader title="防火墙日志" count={live ? "实时" : "已停"}>
        <Button variant="ghost" size="icon" className="h-7 w-7" title={paused ? "继续" : "暂停"} onClick={() => setPaused((p) => !p)}>
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="清屏" onClick={() => setLines([])}><Trash className="h-3.5 w-3.5" /></Button>
        <CopyButton value={shown.join("\n")} className="h-7 w-7" />
        <Button variant="ghost" size="icon" className="h-7 w-7" title="下载" onClick={() => downloadText("firewall.log", shown.join("\n"))}><Download className="h-3.5 w-3.5" /></Button>
      </SectionHeader>
      <div className="border-b bg-card/60 px-3 py-1.5">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤日志行" className="h-7 text-xs" />
      </div>
      <div className="min-h-0 flex-1 bg-muted/40">
        {shown.length === 0 ? (
          <div className="inline-flex items-center gap-2 p-3 text-[11px] text-muted-foreground">
            {live ? <><Loader2 className="h-3 w-3 animate-spin" /> 等待日志…（无防火墙日志时这里会保持空）</> : "已停止"}
          </div>
        ) : (
          <Virtuoso
            data={shown}
            followOutput="auto"
            className="no-scrollbar h-full"
            itemContent={(_i, line) => (
              <div className={cn("whitespace-pre-wrap break-words px-3 py-px font-mono text-[11px] leading-5",
                /BLOCK|DROP|DENY|REJECT/i.test(line) ? "text-destructive" : /ACCEPT|ALLOW/i.test(line) ? "text-success" : "text-muted-foreground")}>
                {line || " "}
              </div>
            )}
          />
        )}
      </div>
    </div>
  )
}
