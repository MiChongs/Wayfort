"use client"

import * as React from "react"
import { use } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { toast } from "@/components/ui/sonner"
import { ArrowLeft, ListTree, Power, Radio } from "lucide-react"
import { sessionService } from "@/lib/api/services"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { useAccess } from "@/lib/hooks/use-access"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { kindMeta, statusMeta, fmtDuration } from "@/lib/session-meta"
import { cn } from "@/lib/utils"
import { SessionKpiBar } from "./components/session-kpi-bar"
import { SessionPhaseGantt } from "./components/session-phase-gantt"
import { SessionQualityChart } from "./components/session-quality-chart"
import { SyncedReplay } from "./components/synced-replay"

export default function SessionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const access = useAccess()
  const canTerminate = access.isSuperadmin || access.permissions.includes("session:terminate")
  const canObserve = access.isSuperadmin || access.permissions.includes("session:observe")

  const sq = useQuery({ queryKey: ["session", id], queryFn: () => sessionService.get(id) })
  const s = sq.data?.session

  const audit = useQuery({
    queryKey: ["session", id, "audit"],
    queryFn: () => sessionService.audit(id),
    enabled: !!s,
    refetchInterval: s?.status === "active" ? 5000 : false,
  })

  // Lifecycle bundle (phases + quality samples) drives the dashboard. Polls
  // while the session is live so the gantt/quality curve grow in place.
  const life = useQuery({
    queryKey: ["session", id, "lifecycle"],
    queryFn: () => sessionService.lifecycle(id),
    enabled: !!s,
    refetchInterval: s?.status === "active" ? 5000 : false,
  })

  if (sq.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">载入会话…</div>
  }
  if (!s) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <EmptyState
          icon={ListTree}
          title="找不到这个会话"
          description="它可能已被清理，或链接有误。"
          action={<Link href="/sessions"><Button variant="outline" size="sm"><ArrowLeft className="h-4 w-4" /> 返回会话列表</Button></Link>}
        />
      </div>
    )
  }

  const km = kindMeta(s.kind)
  const sm = statusMeta(s.status)
  const KindIcon = km.icon
  const isActive = s.status === "active"
  const url = sessionService.recordingURL(s.id)

  async function terminate() {
    if (!s) return
    const ok = await confirmDialog({
      title: "强制下线该会话？",
      description: (
        <>
          将立即断开 <b>{s.username}</b> 在 <b>{s.node_name || "目标"}</b> 上的{km.label}，此操作记入审计。
        </>
      ),
      confirmLabel: "强制下线",
      destructive: true,
    })
    if (!ok) return
    try {
      await sessionService.terminate(s.id)
      toast.success("会话已下线")
      sq.refetch()
      audit.refetch()
    } catch (e) {
      toast.error((e as { message?: string }).message || "下线失败")
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-6">
      <div>
        <Link href="/sessions" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> 会话列表
        </Link>
      </div>

      {/* Hero */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
              <KindIcon className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold">{s.node_name || "匿名目标"}</h1>
                <Badge variant={sm.tone}>{sm.label}</Badge>
                <Badge variant="soft">{km.label}</Badge>
              </div>
              <div className="mt-1 flex items-center gap-1 font-mono text-xs text-muted-foreground">
                {s.id}
                <CopyButton value={s.id} size="icon" className="h-5 w-5" />
              </div>
            </div>
          </div>
          {isActive && (
            <div className="flex items-center gap-2">
              {canObserve && (
                <Link href={`/sessions/${s.id}/monitor`}>
                  <Button variant="outline" size="sm" className="text-primary">
                    <Radio className="h-4 w-4" /> 实时监看
                  </Button>
                </Link>
              )}
              {canTerminate && (
                <Button variant="destructive" size="sm" onClick={terminate}>
                  <Power className="h-4 w-4" /> 强制下线
                </Button>
              )}
            </div>
          )}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
          <Field label="用户" value={s.username} />
          <Field label="来源 IP" value={s.client_ip || "—"} mono />
          <Field label="时长" value={fmtDuration(s.started_at, isActive ? null : s.ended_at)} />
          <Field label="流量" value={`↑${fmtBytes(s.bytes_in)} ↓${fmtBytes(s.bytes_out)}`} />
          <Field label="开始" value={fullTime(s.started_at)} hint={relTime(s.started_at)} />
          <Field label="结束" value={s.ended_at ? fullTime(s.ended_at) : isActive ? "进行中" : "—"} />
          {s.reason && <Field label="结束原因" value={s.reason} className="col-span-2 sm:col-span-3 lg:col-span-4" />}
        </dl>
      </div>

      {/* Lifecycle dashboard — KPIs, connection-stage gantt, quality curve */}
      <SessionKpiBar session={life.data?.session ?? s} samples={life.data?.samples ?? []} />
      <SessionPhaseGantt
        phases={life.data?.phases ?? []}
        startedAt={s.started_at}
        endedAt={isActive ? null : s.ended_at}
      />
      <SessionQualityChart samples={life.data?.samples ?? []} />

      {/* Recording ↔ audit synced axis */}
      <SyncedReplay session={s} events={audit.data?.events ?? []} url={url} live={isActive} loading={audit.isLoading} />
    </div>
  )
}

function Field({
  label, value, hint, mono, className,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  mono?: boolean
  className?: string
}) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words", mono && "font-mono text-xs")}>{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}
/* Recording + Timeline + CastPlayer moved into ./components/synced-replay,
   synced-timeline, and cast-player — the detail page now renders the synced
   axis directly. */
