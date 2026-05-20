"use client"

// Phase 11 — Command History Sheet. Surfaces opt-in captured commands from
// the backend so operators can re-run anything they typed in the last days
// across nodes. The sheet doubles as a quick-insert palette: clicking a row
// fires `onInsert` with the command body.
//
// Opt-in toggle lives in the toolbar; the empty state nudges users to flip
// the switch if it's off.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion } from "motion/react"
import {
  ClipboardPaste,
  History,
  Loader2,
  Search,
  Server,
  ShieldQuestion,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { commandHistoryService, terminalProfileService } from "@/lib/api/services"

export interface TerminalHistorySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, only show history scoped to this node — used by the
   * per-session toolbar entry point. */
  nodeId?: number
  onInsert: (command: string) => void
}

export function TerminalHistorySheet({
  open,
  onOpenChange,
  nodeId,
  onInsert,
}: TerminalHistorySheetProps) {
  const qc = useQueryClient()
  const [q, setQ] = React.useState("")
  const [scope, setScope] = React.useState<"node" | "all">(nodeId ? "node" : "all")

  React.useEffect(() => {
    if (!open) {
      setQ("")
      setScope(nodeId ? "node" : "all")
    }
  }, [open, nodeId])

  const profile = useQuery({
    queryKey: ["me", "terminal-profile"],
    queryFn: terminalProfileService.get,
    enabled: open,
  })

  const list = useQuery({
    queryKey: ["me", "command-history", q, scope, nodeId],
    queryFn: () =>
      commandHistoryService.list({
        q: q || undefined,
        node_id: scope === "node" && nodeId ? nodeId : undefined,
        limit: 200,
      }),
    enabled: open && (profile.data?.profile.history_enabled ?? false),
  })

  const setHistoryEnabled = useMutation({
    mutationFn: (on: boolean) => terminalProfileService.set({ history_enabled: on }),
    onSuccess: (_d, on) => {
      qc.invalidateQueries({ queryKey: ["me", "terminal-profile"] })
      qc.invalidateQueries({ queryKey: ["me", "command-history"] })
      toast.success(on ? "命令历史已开启" : "命令历史已关闭")
    },
  })
  const clear = useMutation({
    mutationFn: () => commandHistoryService.clear(scope === "node" ? nodeId : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "command-history"] })
      toast.success("历史已清空")
    },
  })

  const historyEnabled = profile.data?.profile.history_enabled ?? false
  const rows = list.data?.history || []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetHeader className="border-b px-5 pt-5 pb-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" /> 命令历史
          </SheetTitle>
          <SheetDescription>跨会话搜索曾经执行过的命令并一键重插入。</SheetDescription>
        </SheetHeader>

        <div className="space-y-2 border-b bg-muted/20 px-5 py-3">
          <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
            <div className="space-y-0.5">
              <p className="text-xs font-medium">记录命令</p>
              <p className="text-[11px] text-muted-foreground">
                仅记录在终端按下回车确认的命令;关键字 password / secret 自动过滤(前端实施)。
              </p>
            </div>
            <Switch
              checked={historyEnabled}
              onCheckedChange={(v) => setHistoryEnabled.mutate(v)}
            />
          </div>
          {historyEnabled && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="搜索命令..."
                  className="h-8 pl-8"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
              {nodeId && (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant={scope === "node" ? "secondary" : "ghost"}
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setScope("node")}
                  >
                    <Server className="h-3 w-3" /> 本节点
                  </Button>
                  <Button
                    size="sm"
                    variant={scope === "all" ? "secondary" : "ghost"}
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setScope("all")}
                  >
                    全部节点
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1 px-3 py-2">
          {!historyEnabled ? (
            <div className="space-y-2 px-3 py-8 text-center text-xs text-muted-foreground">
              <ShieldQuestion className="mx-auto h-6 w-6 opacity-60" />
              <p>命令历史目前已关闭。</p>
              <p>开启后,你在 WebSSH 中执行的命令会被加密存储,只有你能查看 / 重用。</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setHistoryEnabled.mutate(true)}
                className="mt-2"
              >
                立即开启
              </Button>
            </div>
          ) : list.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中...
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {q ? "没有匹配的命令" : "暂无历史。在终端里按回车执行命令后,记录会自动出现在这里。"}
            </div>
          ) : (
            <div className="space-y-1">
              {rows.map((r) => (
                <motion.button
                  key={r.id}
                  type="button"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "group flex w-full flex-col gap-1 rounded-md border px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                  onClick={() => {
                    onInsert(r.command)
                    onOpenChange(false)
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <pre className="flex-1 truncate font-mono text-xs">{r.command}</pre>
                    <ClipboardPaste className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{new Date(r.created_at).toLocaleString()}</span>
                    {r.node_id != null && (
                      <Badge variant="outline" className="h-3.5 px-1 text-[10px] font-normal">
                        node #{r.node_id}
                      </Badge>
                    )}
                    {r.exit_code !== 0 && (
                      <Badge variant="outline" className="h-3.5 border-destructive/30 bg-destructive/10 px-1 text-[10px] font-normal text-destructive">
                        exit {r.exit_code}
                      </Badge>
                    )}
                    {r.duration_ms > 0 && <span>{r.duration_ms}ms</span>}
                  </div>
                </motion.button>
              ))}
            </div>
          )}
        </ScrollArea>

        {historyEnabled && (
          <SheetFooter className="flex-row items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3">
            <span className="text-[11px] text-muted-foreground">{rows.length} 条记录</span>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10"
              onClick={() => clear.mutate()}
              disabled={rows.length === 0 || clear.isPending}
            >
              {clear.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              清空 {scope === "node" ? "本节点" : "全部"}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
