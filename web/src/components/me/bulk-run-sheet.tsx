"use client"

// Phase 12 — Bulk SSH Run Sheet.
//
// 用户在 Sheet 内选 N 个节点,输入命令,提交后服务端并行 dial + exec,
// 结果分组显示。历史在另一个 tab 里查看,删除/复查每次执行结果。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion } from "motion/react"
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Loader2,
  Play,
  Server,
  Trash2,
  X,
  Zap,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { bulkRunService, meService } from "@/lib/api/services"
import type { BulkRun, BulkRunResult, Node } from "@/lib/api/types"

export function BulkRunSheet({
  trigger,
}: {
  trigger?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState<"new" | "history">("new")
  return (
    <TooltipProvider delayDuration={150}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          {trigger || (
            <Button size="sm" variant="outline">
              <Zap className="h-3.5 w-3.5" /> 批量执行
            </Button>
          )}
        </SheetTrigger>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[720px]">
          <SheetHeader className="border-b px-6 pt-6 pb-4">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4" /> SSH 批量执行
            </SheetTitle>
            <SheetDescription>
              在多台节点上并行运行同一条命令,逐节点查看输出 / 退出码 / 用时。
            </SheetDescription>
          </SheetHeader>
          <Tabs value={tab} onValueChange={(v) => setTab(v as "new" | "history")} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-6 mt-4 self-start">
              <TabsTrigger value="new"><Zap className="h-3.5 w-3.5" /> 新建</TabsTrigger>
              <TabsTrigger value="history"><Clipboard className="h-3.5 w-3.5" /> 历史</TabsTrigger>
            </TabsList>
            <TabsContent value="new" className="mt-0 flex min-h-0 flex-1 flex-col">
              <NewRunPanel onSubmitted={() => setTab("history")} />
            </TabsContent>
            <TabsContent value="history" className="mt-0 flex min-h-0 flex-1 flex-col">
              <HistoryPanel />
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  )
}

function NewRunPanel({ onSubmitted }: { onSubmitted: () => void }) {
  const qc = useQueryClient()
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const [selected, setSelected] = React.useState<Set<number>>(new Set())
  const [filter, setFilter] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [command, setCommand] = React.useState("")
  const [parallel, setParallel] = React.useState(4)
  const [timeout, setTimeoutSecs] = React.useState(60)
  const [latest, setLatest] = React.useState<{ run: BulkRun; results: BulkRunResult[] } | null>(null)

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = (nodes.data?.nodes || []).filter((n) => n.protocol === "ssh")
    if (!q) return list
    return list.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.host.toLowerCase().includes(q) ||
        (n.tags || "").toLowerCase().includes(q),
    )
  }, [nodes.data, filter])

  const toggle = (id: number) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allFilteredOn = filtered.length > 0 && filtered.every((n) => selected.has(n.id))
  const toggleAll = () => {
    setSelected((s) => {
      const next = new Set(s)
      if (allFilteredOn) {
        for (const n of filtered) next.delete(n.id)
      } else {
        for (const n of filtered) next.add(n.id)
      }
      return next
    })
  }

  const run = useMutation({
    mutationFn: () =>
      bulkRunService.run({
        title: title.trim() || undefined,
        command,
        node_ids: Array.from(selected),
        parallel,
        timeout_seconds: timeout,
      }),
    onSuccess: (r) => {
      setLatest(r)
      qc.invalidateQueries({ queryKey: ["me", "bulk-runs"] })
      toast.success(`完成: ${r.run.ok_count} 成功 / ${r.run.fail_count} 失败`)
    },
    onError: (e: Error) => toast.error("执行失败", { description: e.message }),
  })

  const canRun = selected.size > 0 && !!command.trim() && !run.isPending

  return (
    <>
      <ScrollArea className="min-h-0 flex-1 px-6 py-4">
        <div className="space-y-4">
          <Field label="任务名(可选)">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如:全网巡检 uptime" />
          </Field>
          <Field label="命令" required>
            <Textarea
              rows={4}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="如: uptime"
              className="font-mono text-xs"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="并发">
              <Input
                type="number"
                min={1}
                max={16}
                value={parallel}
                onChange={(e) => setParallel(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
              />
            </Field>
            <Field label="超时(秒)">
              <Input
                type="number"
                min={5}
                max={300}
                value={timeout}
                onChange={(e) => setTimeoutSecs(Math.max(5, Math.min(300, Number(e.target.value) || 60)))}
              />
            </Field>
          </div>
          <Separator />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                选择节点 ({selected.size} / {filtered.length})
              </Label>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={toggleAll}>
                {allFilteredOn ? "取消全选" : "全选当前"}
              </Button>
            </div>
            <Input
              placeholder="按名称 / host / tag 过滤..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8"
            />
            <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-1">
              {nodes.isLoading ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">加载中...</div>
              ) : filtered.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">无匹配节点</div>
              ) : (
                filtered.map((n) => (
                  <NodeOption
                    key={n.id}
                    node={n}
                    selected={selected.has(n.id)}
                    onToggle={() => toggle(n.id)}
                  />
                ))
              )}
            </div>
          </div>

          {latest && (
            <Card>
              <CardContent className="space-y-2 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">最近运行结果</span>
                  <Badge variant="outline">{latest.run.ok_count}✓ / {latest.run.fail_count}✗ · {latest.run.duration_ms}ms</Badge>
                </div>
                <ResultsList results={latest.results} />
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
      <SheetFooter className="flex-row items-center justify-between gap-2 border-t bg-muted/30 px-6 py-3">
        <span className="text-[11px] text-muted-foreground">
          {selected.size > 0 ? `${selected.size} 个目标 · 并发 ${parallel} · 超时 ${timeout}s` : "请先选择节点"}
        </span>
        <div className="flex items-center gap-2">
          {latest && (
            <Button size="sm" variant="ghost" onClick={onSubmitted}>查看历史</Button>
          )}
          <Button onClick={() => run.mutate()} disabled={!canRun}>
            {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            执行
          </Button>
        </div>
      </SheetFooter>
    </>
  )
}

function NodeOption({
  node,
  selected,
  onToggle,
}: {
  node: Node
  selected: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
        selected && "bg-primary/10 hover:bg-primary/15",
      )}
    >
      <span
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {selected && <CheckCircle2 className="h-2.5 w-2.5" />}
      </span>
      <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
      <span className="hidden truncate text-muted-foreground font-mono md:inline">
        {node.host}:{node.port}
      </span>
    </button>
  )
}

function HistoryPanel() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["me", "bulk-runs"], queryFn: () => bulkRunService.list(50) })
  const [openId, setOpenId] = React.useState<number | null>(null)
  const detail = useQuery({
    queryKey: ["me", "bulk-run", openId],
    queryFn: () => (openId ? bulkRunService.get(openId) : Promise.resolve(null)),
    enabled: openId !== null,
  })
  const remove = useMutation({
    mutationFn: (id: number) => bulkRunService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "bulk-runs"] })
      setOpenId(null)
    },
  })
  const rows = list.data?.runs || []
  return (
    <ScrollArea className="min-h-0 flex-1 px-6 py-4">
      {list.isLoading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中...
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">
          暂无历史
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <motion.div
              key={r.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <Card className={cn(openId === r.id && "border-primary ring-1 ring-primary")}>
                <CardContent className="space-y-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenId(openId === r.id ? null : r.id)}
                      className="flex flex-1 items-center gap-2 truncate text-left"
                    >
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                          openId === r.id && "rotate-90",
                        )}
                      />
                      <span className="truncate text-sm font-medium">{r.title}</span>
                    </button>
                    <Badge variant="outline" className="font-normal">
                      <CheckCircle2 className="mr-1 h-3 w-3 text-emerald-500" />
                      {r.ok_count}
                    </Badge>
                    {r.fail_count > 0 && (
                      <Badge variant="outline" className="border-destructive/30 bg-destructive/10 font-normal text-destructive">
                        <AlertCircle className="mr-1 h-3 w-3" />
                        {r.fail_count}
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground">{r.duration_ms}ms</span>
                    <ConfirmDeleteIconButton
                      className="h-6 w-6"
                      iconClassName="h-3 w-3"
                      title={`删除运行记录 "${r.title}"?`}
                      description="历史记录会被清理,无法恢复。"
                      loading={remove.isPending}
                      onConfirm={() => remove.mutate(r.id)}
                    />
                  </div>
                  <pre className="overflow-x-auto rounded bg-muted/30 px-2 py-1 font-mono text-[10px]">
                    {r.command.length > 200 ? r.command.slice(0, 200) + "…" : r.command}
                  </pre>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{new Date(r.created_at).toLocaleString()}</span>
                    <span>· {r.node_count} 节点</span>
                  </div>
                  {openId === r.id && detail.data && (
                    <ResultsList results={detail.data.results} />
                  )}
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </ScrollArea>
  )
}

function ResultsList({ results }: { results: BulkRunResult[] }) {
  return (
    <div className="space-y-1.5">
      {results.map((res) => (
        <div key={res.id || `${res.node_id}-${res.created_at}`} className="space-y-0.5 rounded-md border bg-card p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 truncate">
              {res.error || res.exit_code !== 0 ? (
                <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
              ) : (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
              )}
              <span className="truncate text-xs font-medium">{res.node_name || `node #${res.node_id}`}</span>
            </div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {res.error ? (
                <span className="text-destructive">{res.error.slice(0, 40)}</span>
              ) : (
                <span>exit {res.exit_code}</span>
              )}
              <span>· {res.duration_ms}ms</span>
            </div>
          </div>
          {(res.stdout || res.stderr) && (
            <details className="text-[10px] text-muted-foreground">
              <summary className="cursor-pointer">输出</summary>
              {res.stdout && (
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/30 p-1.5 font-mono">{res.stdout}</pre>
              )}
              {res.stderr && (
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-destructive/10 p-1.5 font-mono text-destructive">{res.stderr}</pre>
              )}
            </details>
          )}
        </div>
      ))}
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
    </div>
  )
}

void X
void Trash2
