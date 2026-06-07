"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfirm } from "@/components/admin/use-confirm"
import { cronService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { RunInTerminalButton, codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied") return "需要相应权限（系统 cron / timer 改动可能需 root）。"
  if (code === "bad_request") return "crontab 表达式或参数不合法。"
  return ""
}

export function CronTab({ nodeId, tabId, active }: Props) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [adding, setAdding] = React.useState(false)
  const info = useQuery({
    queryKey: ["cron", nodeId],
    queryFn: () => cronService.info(nodeId),
    enabled: active,
    refetchInterval: 30_000,
    retry: false,
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["cron", nodeId] })

  const remove = useMutation({
    mutationFn: (index: number) => cronService.remove(nodeId, index),
    onSuccess: () => { toast.success("已删除任务"); invalidate() },
    onError: (e: ApiError) => toast.error("删除失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })
  const timer = useMutation({
    mutationFn: ({ unit, enable }: { unit: string; enable: boolean }) => cronService.setTimer(nodeId, unit, enable),
    onSuccess: (_d, v) => { toast.success(`${v.unit} 已${v.enable ? "启用" : "停用"}`); invalidate() },
    onError: (e: ApiError) => toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  if (!active) return null

  if (info.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Clock className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法读取定时任务</div>
        <div className="text-xs">{(info.error as ApiError)?.message}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => info.refetch()}><RefreshCw className="w-3 h-3" /> 重试</Button>
      </div>
    )
  }
  const d = info.data

  return (
    <div className="flex flex-col h-full">
      {dialog}
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">定时任务</span>
        </div>
        <div className="flex items-center gap-1">
          <RunInTerminalButton tabId={tabId} command="crontab -e" label="在终端 crontab -e" />
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => info.refetch()} title="刷新"><RefreshCw className={cn("w-3 h-3", info.isFetching && "animate-spin")} /></Button>
        </div>
      </header>

      <Tabs defaultValue="crontab" className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-2 mt-2 h-8 bg-transparent border-b rounded-none p-0 self-start">
          <TabsTrigger value="crontab" className="text-xs">crontab</TabsTrigger>
          <TabsTrigger value="timers" className="text-xs">timers</TabsTrigger>
          <TabsTrigger value="system" className="text-xs">系统</TabsTrigger>
        </TabsList>

        <TabsContent value="crontab" className="flex-1 min-h-0 mt-0 flex flex-col">
          <div className="px-2 py-1.5 border-b flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">当前用户 crontab</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdding(true)} disabled={!d?.has_crontab}><Plus className="w-3 h-3" /> 添加</Button>
          </div>
          <div className="flex-1 overflow-auto">
            {!d ? (
              <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</div>
            ) : d.user_cron.length === 0 ? (
              <div className="text-xs text-muted-foreground p-6 text-center">无 crontab 任务</div>
            ) : (
              <table className="w-full text-[11px]">
                <tbody className="divide-y divide-border/40">
                  {d.user_cron.map((e) => (
                    <tr key={e.index} className="hover:bg-muted/50 group">
                      <td className="px-3 py-1 font-mono text-primary whitespace-nowrap align-top">{e.schedule || "—"}</td>
                      <td className="px-2 py-1 font-mono align-top break-all">{e.command}</td>
                      <td className="px-2 py-1 text-right align-top w-8">
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive opacity-0 group-hover:opacity-100" title="删除"
                          onClick={async () => { if (await confirm({ title: "删除该 crontab 行？", description: e.raw, confirmLabel: "删除" })) remove.mutate(e.index) }}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </TabsContent>

        <TabsContent value="timers" className="flex-1 min-h-0 mt-0 overflow-auto">
          {(d?.timers?.length ?? 0) === 0 ? (
            <div className="text-xs text-muted-foreground p-6 text-center">无 systemd timers</div>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="bg-muted/40 sticky top-0 text-[10px] uppercase text-muted-foreground">
                <tr><th className="text-left px-3 py-1.5">timer</th><th className="text-left px-2 py-1.5">触发</th><th className="text-right px-3 py-1.5">操作</th></tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {d!.timers!.map((t) => (
                  <tr key={t.unit} className="hover:bg-muted/50">
                    <td className="px-3 py-1 font-mono truncate max-w-[10rem]" title={t.unit}>{t.unit}</td>
                    <td className="px-2 py-1 text-muted-foreground truncate max-w-[8rem]" title={t.activates}>{t.activates || t.next || "—"}</td>
                    <td className="px-3 py-1 text-right">
                      <div className="inline-flex gap-0.5">
                        <Button variant="ghost" size="sm" className="h-6 text-[11px]" disabled={timer.isPending} onClick={() => timer.mutate({ unit: t.unit, enable: true })}>启用</Button>
                        <Button variant="ghost" size="sm" className="h-6 text-[11px]" disabled={timer.isPending} onClick={() => timer.mutate({ unit: t.unit, enable: false })}>停用</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TabsContent>

        <TabsContent value="system" className="flex-1 min-h-0 mt-0 overflow-auto p-3">
          {(d?.system_cron?.length ?? 0) === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">无系统 cron 条目（或无权读取）</div>
          ) : (
            <pre className="font-mono text-[10px] whitespace-pre-wrap leading-5">{d!.system_cron!.join("\n")}</pre>
          )}
        </TabsContent>
      </Tabs>

      <AddCronDialog open={adding} onClose={() => setAdding(false)} nodeId={nodeId} onAdded={() => { setAdding(false); invalidate() }} />
    </div>
  )
}

function AddCronDialog({ open, onClose, nodeId, onAdded }: { open: boolean; onClose: () => void; nodeId: number; onAdded: () => void }) {
  const [schedule, setSchedule] = React.useState("0 3 * * *")
  const [command, setCommand] = React.useState("")
  React.useEffect(() => { if (open) { setSchedule("0 3 * * *"); setCommand("") } }, [open])
  const submit = useMutation({
    mutationFn: () => cronService.add(nodeId, `${schedule.trim()} ${command.trim()}`),
    onSuccess: () => { toast.success("已添加任务"); onAdded() },
    onError: (e: ApiError) => toast.error("添加失败", { description: e?.message }),
  })
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加 crontab 任务</DialogTitle>
          <DialogDescription>追加到当前用户的 crontab；操作会被审计。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">调度表达式</label>
            <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" placeholder="0 3 * * *  或  @reboot" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">命令</label>
            <Input value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono" placeholder="/usr/bin/backup.sh" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submit.isPending}>取消</Button>
          <Button onClick={() => submit.mutate()} disabled={!command.trim() || submit.isPending}>{submit.isPending ? "添加中…" : "添加"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
