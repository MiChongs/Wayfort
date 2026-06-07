"use client"

import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Clock,
  Code2,
  CornerDownLeft,
  Loader2,
  Play,
  TerminalSquare,
  Trash2,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { bulkRunService, commandHistoryService, snippetService } from "@/lib/api/services"
import type { BulkRunResult } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { useSendToTerminal, type ApiError } from "./_shared"

type Props = {
  nodeId: number
  tabId: string
  active: boolean
}

const TIMEOUTS = [10, 30, 60, 120, 300]

// CommandRunnerTab — a one-shot command runner that executes against THIS node
// over a fresh SSH session (reusing the bulk-run engine) and captures
// stdout/stderr/exit, plus a one-click bridge to type the same command into the
// live terminal. Snippets and per-node history are wired in for fast recall.
export function CommandRunnerTab({ nodeId, tabId, active }: Props) {
  const [command, setCommand] = React.useState("")
  const [timeout, setTimeout] = React.useState(30)
  const [result, setResult] = React.useState<BulkRunResult | null>(null)
  const send = useSendToTerminal(tabId)

  const history = useQuery({
    queryKey: ["command-history", "node", nodeId],
    queryFn: () => commandHistoryService.list({ node_id: nodeId, limit: 30 }),
    enabled: active,
    retry: false,
  })

  const run = useMutation({
    mutationFn: () =>
      bulkRunService.run({
        title: `runner@${nodeId}`,
        command,
        node_ids: [nodeId],
        parallel: 1,
        timeout_seconds: timeout,
      }),
    onSuccess: (data) => {
      const r = data.results?.[0] ?? null
      setResult(r)
      if (r && r.exit_code === 0 && !r.error) toast.success("执行完成")
      else if (r?.error) toast.error("执行失败", { description: r.error })
      else toast.warning(`退出码 ${r?.exit_code ?? "?"}`)
      void history.refetch()
    },
    onError: (e: ApiError) => toast.error("执行失败", { description: e?.message }),
  })

  const onSubmit = () => {
    if (!command.trim() || run.isPending) return
    run.mutate()
  }

  if (!active) return null

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalSquare className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">命令运行器</span>
          <span className="text-[10px] text-muted-foreground truncate">旁路 SSH 执行并捕获输出</span>
        </div>
      </header>

      {/* Editor */}
      <div className="p-2 space-y-2 border-b">
        <textarea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault()
              onSubmit()
            }
          }}
          rows={3}
          spellCheck={false}
          placeholder="输入要执行的命令，Ctrl+Enter 运行…"
          className={cn(
            "w-full resize-y rounded-md border bg-background px-2.5 py-2 font-mono text-xs leading-5",
            "outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:border-primary/60",
          )}
        />
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button size="sm" className="h-7 text-xs" onClick={onSubmit} disabled={!command.trim() || run.isPending}>
            {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            运行
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => send(command, true)}
            disabled={!command.trim()}
            title="把命令打进当前终端并回车执行"
          >
            <TerminalSquare className="w-3.5 h-3.5" /> 发送到终端
          </Button>
          <SnippetPopover onPick={(body) => setCommand((c) => (c ? `${c}\n${body}` : body))} />
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">超时</span>
            <Select value={String(timeout)} onValueChange={(v) => setTimeout(Number(v))}>
              <SelectTrigger className="h-7 w-auto min-w-0 gap-1 text-[11px] border-border/60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEOUTS.map((t) => (
                  <SelectItem key={t} value={String(t)} className="text-xs">
                    {t}s
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground">
          ⓘ 旁路执行使用与终端相同的凭据，独立 SSH 会话（非当前终端）。需 PTY 交互的命令请用「发送到终端」。
        </div>
      </div>

      {/* Output + history */}
      <div className="flex-1 overflow-auto">
        {result ? (
          <ResultPanel
            result={result}
            onRerun={() => onSubmit()}
            onSendToTerminal={() => send(command, true)}
          />
        ) : (
          <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">
            还没有输出。运行一条命令试试。
          </div>
        )}

        {(history.data?.history?.length ?? 0) > 0 && (
          <section className="border-t mt-1">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" /> 本节点最近命令
            </div>
            <div className="pb-2">
              {history.data!.history.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setCommand(h.command)}
                  className="w-full text-left px-3 py-1 hover:bg-accent/50 flex items-center gap-2"
                  title="点按填入命令框"
                >
                  <span
                    className={cn(
                      "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                      h.exit_code === 0 ? "bg-success" : "bg-destructive",
                    )}
                  />
                  <span className="font-mono text-[11px] truncate flex-1">{h.command}</span>
                  <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                    {h.duration_ms}ms
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function ResultPanel({
  result,
  onRerun,
  onSendToTerminal,
}: {
  result: BulkRunResult
  onRerun: () => void
  onSendToTerminal: () => void
}) {
  const ok = result.exit_code === 0 && !result.error
  return (
    <div className="p-2 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={ok ? "success" : "destructive"} className="text-[10px]">
          退出码 {result.exit_code}
        </Badge>
        <span className="text-[10px] text-muted-foreground tabular-nums">{result.duration_ms}ms</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onRerun}>
            <CornerDownLeft className="w-3 h-3" /> 重跑
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onSendToTerminal}>
            <TerminalSquare className="w-3 h-3" /> 改到终端
          </Button>
        </div>
      </div>
      {result.error && (
        <div className="text-[11px] text-destructive break-words">{result.error}</div>
      )}
      {result.stdout && (
        <pre className="bg-muted/60 rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words leading-5 max-h-[40vh] overflow-auto">
          {result.stdout}
        </pre>
      )}
      {result.stderr && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-destructive/80 mb-1">stderr</div>
          <pre className="bg-destructive/[0.06] border border-destructive/30 rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words leading-5 max-h-[24vh] overflow-auto">
            {result.stderr}
          </pre>
        </div>
      )}
      {!result.stdout && !result.stderr && !result.error && (
        <div className="text-[11px] text-muted-foreground">（无输出）</div>
      )}
    </div>
  )
}

function SnippetPopover({ onPick }: { onPick: (body: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const snippets = useQuery({
    queryKey: ["me", "snippets"],
    queryFn: () => snippetService.list(),
    enabled: open,
    retry: false,
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs">
          <Code2 className="w-3.5 h-3.5" /> 片段
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        {snippets.isLoading ? (
          <div className="text-xs text-muted-foreground p-3 inline-flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> 加载片段…
          </div>
        ) : (snippets.data?.snippets?.length ?? 0) === 0 ? (
          <div className="text-xs text-muted-foreground p-3 text-center">
            还没有命令片段。在终端的「片段」里创建。
          </div>
        ) : (
          <div className="max-h-72 overflow-auto">
            {snippets.data!.snippets.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onPick(s.body)
                  setOpen(false)
                }}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-accent/60"
              >
                <div className="text-xs font-medium truncate">{s.name}</div>
                <div className="font-mono text-[10px] text-muted-foreground truncate">{s.body}</div>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
