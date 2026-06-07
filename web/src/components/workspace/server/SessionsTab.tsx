"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Loader2, PowerOff, RefreshCw } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useConfirm } from "@/components/admin/use-confirm"
import { VirtualTable } from "@/components/common/virtual-table"
import { fullTime, relTime } from "@/lib/format"
import { sessionService } from "@/lib/api/services"
import type { Session } from "@/lib/api/types"
import { type ApiError } from "./_shared"

type Props = { nodeId: number }

// SessionsTab — embedded session audit for this node: a virtualised recent-
// session list plus an inline detail sheet (metadata + command-audit timeline +
// force-terminate + asciinema recording playback), so the operator never leaves
// the workspace.
export function SessionsTab({ nodeId }: Props) {
  const [openId, setOpenId] = React.useState<string | null>(null)
  const list = useQuery({
    queryKey: ["sessions", "node", nodeId],
    queryFn: () => sessionService.list({ node_id: nodeId, limit: 200 }),
    refetchInterval: 30_000,
  })
  const rows = list.data?.sessions ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b px-3 py-2 text-xs">
        <span className="font-medium">本节点最近会话 · {rows.length}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void list.refetch()}>
          <RefreshCw className={`h-3 w-3 ${list.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        {list.isLoading ? (
          <div className="inline-flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 加载中…</div>
        ) : (
          <VirtualTable<Session>
            rows={rows}
            empty="本节点尚无会话记录"
            header={
              <>
                <th className="px-2 py-1.5 text-left">用户</th>
                <th className="w-12 px-2 py-1.5 text-left">类型</th>
                <th className="px-2 py-1.5 text-left">开始</th>
                <th className="w-16 px-2 py-1.5 text-left">状态</th>
                <th className="w-8 px-2 py-1.5"></th>
              </>
            }
            renderRow={(s) => (
              <>
                <td className="max-w-[7rem] truncate px-2 py-1.5" title={s.username}>{s.username}</td>
                <td className="px-2 py-1.5 uppercase">{s.kind}</td>
                <td className="px-2 py-1.5">
                  <div>{fullTime(s.started_at)}</div>
                  <div className="text-[10px] text-muted-foreground">{relTime(s.started_at)}</div>
                </td>
                <td className="px-2 py-1.5"><Badge variant={statusVariant(s.status)}>{s.status}</Badge></td>
                <td className="px-2 py-1.5 text-right">
                  <button type="button" className="text-muted-foreground hover:text-primary" title="查看详情" onClick={() => setOpenId(s.id)}>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </td>
              </>
            )}
          />
        )}
      </div>

      <SessionDetailSheet id={openId} onClose={() => setOpenId(null)} />
    </div>
  )
}

function SessionDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const detail = useQuery({ queryKey: ["sessions", "get", id], queryFn: () => sessionService.get(id as string), enabled: !!id })
  const audit = useQuery({ queryKey: ["sessions", "audit", id], queryFn: () => sessionService.audit(id as string), enabled: !!id })
  const s = detail.data?.session
  const events = audit.data?.events ?? []

  const terminate = useMutation({
    mutationFn: () => sessionService.terminate(id as string),
    onSuccess: (r) => {
      toast.success(r.live ? "已强制下线" : "会话已标记终止")
      void qc.invalidateQueries({ queryKey: ["sessions"] })
    },
    onError: (e: ApiError) => toast.error("操作失败", { description: e?.message }),
  })

  const replayable = !!s && (s.kind === "interactive" || s.kind === "anonymous")

  return (
    <Sheet open={!!id} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="flex w-[min(720px,calc(100vw-2rem))] flex-col gap-3 sm:max-w-none">
        {dialog}
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{s ? `${s.username} · ${s.kind.toUpperCase()}` : "会话详情"}</SheetTitle>
          <SheetDescription>{s ? `${s.node_name ?? ""} · ${fullTime(s.started_at)}` : ""}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-1">
          {detail.isLoading && <div className="inline-flex items-center gap-2 py-4 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载…</div>}

          {s && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                {s.status === "active" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs text-destructive hover:text-destructive"
                    disabled={terminate.isPending}
                    onClick={async () => { if (await confirm({ title: "强制下线该会话？", description: "将立即断开用户的活动连接。", confirmLabel: "强制下线" })) terminate.mutate() }}
                  >
                    <PowerOff className="h-3.5 w-3.5" /> 强制下线
                  </Button>
                )}
              </div>

              {replayable && (
                <section className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">录像回放</div>
                  <Recording id={s.id} />
                </section>
              )}

              <section className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">命令审计 · {events.length}</div>
                {audit.isLoading ? (
                  <div className="inline-flex items-center gap-2 py-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载审计…</div>
                ) : events.length === 0 ? (
                  <div className="rounded-md border p-3 text-center text-xs text-muted-foreground">无命令审计记录</div>
                ) : (
                  <div className="divide-y rounded-md border">
                    {events.map((ev) => (
                      <div key={ev.id} className="flex items-start gap-2 px-2.5 py-1.5 text-[11px]">
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title={fullTime(ev.created_at)}>{relTime(ev.created_at)}</span>
                        <span className="min-w-0 flex-1 break-words font-mono">{ev.payload || ev.kind}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// Lazily mounts the asciinema player for a session recording. Disposes on close.
function Recording({ id }: { id: string }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    let player: { dispose?: () => void } | null = null
    let cancelled = false
    void import("asciinema-player")
      .then((m) => {
        if (cancelled || !ref.current) return
        player = m.create(sessionService.recordingURL(id), ref.current, { fit: "width", terminalFontSize: "12px" })
      })
      .catch(() => { /* recording may not exist */ })
    return () => {
      cancelled = true
      try { player?.dispose?.() } catch { /* */ }
    }
  }, [id])
  return <div ref={ref} className="overflow-hidden rounded-md border bg-muted/40" />
}

function statusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "active":
      return "default"
    case "closed":
      return "secondary"
    case "errored":
    case "terminated":
      return "destructive"
    default:
      return "outline"
  }
}
