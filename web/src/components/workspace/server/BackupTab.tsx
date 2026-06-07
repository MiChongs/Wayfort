"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Archive, Clock, HardDriveDownload, Loader2, Plus, RotateCw, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useConfirm } from "@/components/admin/use-confirm"
import { backupService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|password is required/i.test(msg))
    return "需 root / sudo NOPASSWD。换 root 凭据或配置 sudoers。"
  if (code === "unreachable") return "节点 SSH 不可达。"
  return ""
}

export function BackupTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [method, setMethod] = React.useState<"tar" | "rsync">("tar")
  const [src, setSrc] = React.useState("/etc")
  const [dest, setDest] = React.useState("/var/backups/etc.tar.gz")
  const [output, setOutput] = React.useState<string | null>(null)

  const info = useQuery({ queryKey: ["backup", nodeId], queryFn: () => backupService.info(nodeId), enabled: active, retry: false })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ["backup", nodeId] })

  const snap = useMutation({
    mutationFn: () => backupService.snapshot(nodeId, method, src.trim(), dest.trim()),
    onSuccess: (r) => { setOutput(r.output || "（完成，无输出）"); toast.success("快照完成") },
    onError: (e: ApiError) => toast.error("快照失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })
  const addAt = useMutation({
    mutationFn: ({ when, command }: { when: string; command: string }) => backupService.addAt(nodeId, when, command),
    onSuccess: () => { toast.success("已排程"); invalidate() },
    onError: (e: ApiError) => toast.error("排程失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })
  const rmAt = useMutation({
    mutationFn: (id: string) => backupService.removeAt(nodeId, id),
    onSuccess: () => { toast.success("已取消"); invalidate() },
    onError: (e: ApiError) => toast.error("取消失败", { description: e?.message }),
  })

  if (!active) return null
  const tools = info.data?.tools
  const jobs = info.data?.at_jobs ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <header className="flex items-center justify-between gap-2 border-b bg-card px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Archive className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-xs font-medium">备份与计划</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => info.refetch()} title="刷新"><RotateCw className={cn("h-3.5 w-3.5", info.isFetching && "animate-spin")} /></Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {tools && (
          <div className="flex flex-wrap gap-1.5">
            {(["tar", "rsync", "restic", "at"] as const).map((t) => (
              <Badge key={t} variant={tools[t] ? "success" : "outline"} className="text-[10px]">{t}{tools[t] ? "" : " ✗"}</Badge>
            ))}
          </div>
        )}

        <div className="space-y-2 rounded-lg border p-3">
          <div className="inline-flex items-center gap-1.5 text-xs font-medium"><HardDriveDownload className="h-3.5 w-3.5 text-primary" /> 一键快照</div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant={method === "tar" ? "default" : "outline"} className="h-7 text-[11px]" onClick={() => setMethod("tar")}>tar.gz</Button>
            <Button size="sm" variant={method === "rsync" ? "default" : "outline"} className="h-7 text-[11px]" onClick={() => setMethod("rsync")}>rsync</Button>
          </div>
          <Input value={src} onChange={(e) => setSrc(e.target.value)} placeholder="源路径 /etc" className="h-7 text-xs font-mono" />
          <Input value={dest} onChange={(e) => setDest(e.target.value)} placeholder={method === "tar" ? "目标 /var/backups/etc.tar.gz" : "目标目录 /var/backups/etc"} className="h-7 text-xs font-mono" />
          <Button size="sm" className="h-7 w-full text-xs" disabled={!src.trim() || !dest.trim() || snap.isPending} onClick={() => snap.mutate()}>
            {snap.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> 执行中…</> : "创建快照"}
          </Button>
        </div>

        <div className="rounded-lg border">
          <div className="flex items-center justify-between border-b px-3 py-1.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium"><Clock className="h-3.5 w-3.5 text-primary" /> 计划作业 (at) · {jobs.length}</span>
            <AddAtPopover busy={addAt.isPending} onAdd={(when, command) => addAt.mutate({ when, command })} />
          </div>
          {info.isLoading ? (
            <div className="inline-flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 加载…</div>
          ) : jobs.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">无计划作业</div>
          ) : (
            <div className="divide-y">
              {jobs.map((j) => (
                <div key={j.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                  <Badge variant="outline" className="h-4 px-1.5 font-mono text-[10px]">#{j.id}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={j.when}>{j.when}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{j.user}</span>
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-destructive" title="取消作业" disabled={rmAt.isPending} onClick={async () => { if (await confirm({ title: `取消作业 #${j.id}？`, confirmLabel: "取消作业" })) rmAt.mutate(j.id) }}><Trash2 className="h-3 w-3" /></Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Sheet open={!!output} onOpenChange={(v) => !v && setOutput(null)}>
        <SheetContent side="right" className="flex w-[min(600px,calc(100vw-2rem))] flex-col gap-3 sm:max-w-none">
          <SheetHeader><SheetTitle>快照输出</SheetTitle></SheetHeader>
          <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px]">{output}</pre>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function AddAtPopover({ busy, onAdd }: { busy: boolean; onAdd: (when: string, command: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const [when, setWhen] = React.useState("now + 1 hour")
  const [command, setCommand] = React.useState("")
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={busy}><Plus className="h-3 w-3" /> 排程</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-3">
        <div className="text-xs font-medium">新增 at 作业</div>
        <Input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="时间，如 03:00 或 now + 1 hour" className="h-7 text-xs font-mono" />
        <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="命令，如 tar -czf /var/backups/etc.tar.gz /etc" className="h-7 text-xs font-mono" />
        <div className="text-[10px] text-muted-foreground">作业在该节点上以你的 SSH 用户(或 sudo)执行。</div>
        <Button size="sm" className="h-7 w-full text-xs" disabled={!when.trim() || !command.trim()} onClick={() => { onAdd(when.trim(), command.trim()); setCommand(""); setOpen(false) }}>排程</Button>
      </PopoverContent>
    </Popover>
  )
}
