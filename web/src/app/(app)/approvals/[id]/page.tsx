"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  FileText,
  Hash,
  Loader2,
  ShieldCheck,
  UserCheck,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { CopyButton } from "@/components/common/copy-button"
import { approvalService } from "@/lib/api/services"
import { useApprovalStream } from "@/lib/hooks/use-approval-stream"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { useAccess } from "@/lib/hooks/use-access"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  BIZ_ICONS,
  bizLabel,
  eventLabel,
  riskMeta,
  statusMeta,
  resourceTypeLabel,
} from "@/lib/approvals/meta"
import { DecisionPanel } from "@/components/approvals/decision"
import { GrantCard } from "@/components/approvals/grant-card"
import { StageStepper } from "@/components/approvals/stage-stepper"
import type { ApprovalGrantRow } from "@/lib/api/types"

export default function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const me = useCurrentUser()
  const access = useAccess()

  // The stream hook keeps the detail live (SSE + slow poll) and invalidates
  // the same ["approval", id] key the query below reads.
  const detailQ = useApprovalStream(id)
  const detail = detailQ.data

  const verify = useMutation({
    mutationFn: () => approvalService.verifyChain(id),
    onSuccess: (r) => {
      if (r.ok) toast.success(`审计链完整，共 ${r.total_events} 条事件`)
      else toast.error(`审计链异常：事件 #${r.first_bad_event_id} — ${r.reason}`)
    },
    onError: (e: { message?: string }) => toast.error(e.message || "校验失败"),
  })

  const cancelMut = useMutation({
    mutationFn: () => approvalService.cancel(id, "申请人撤销"),
    onSuccess: () => {
      toast.success("已撤销申请")
      qc.invalidateQueries({ queryKey: ["approval", id] })
    },
    onError: (e: { message?: string }) => toast.error(e.message || "撤销失败"),
  })

  if (detailQ.isLoading && !detail) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <div className="h-40 animate-pulse rounded-xl border bg-muted/40" />
      </div>
    )
  }
  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        <BackLink />
        <div className="rounded-xl border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
          审批请求不存在，或你无权查看。
        </div>
      </div>
    )
  }

  const { request: r, tasks, events, grant } = detail
  const Icon = BIZ_ICONS[r.business_type] ?? ShieldCheck
  const sm = statusMeta(r.status)
  const risk = riskMeta(r.risk_level)
  const myTasks = tasks.filter((t) => t.approver_id === me?.uid && t.state === "pending")
  const canCancel = me?.uid === r.requester_id && r.status === "pending"

  const onCancel = async () => {
    const ok = await confirmDialog({
      title: "撤销这条申请？",
      description: "撤销后流程立即结束，如仍需访问请重新发起。",
      destructive: true,
      confirmLabel: "撤销申请",
    })
    if (ok) cancelMut.mutate()
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
      <BackLink />

      {/* header */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold">{r.title || `${bizLabel(r.business_type)}申请`}</h1>
              <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", sm.badge)}>
                <sm.icon className="h-3 w-3" /> {sm.label}
              </span>
              <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", risk.badge)}>
                <risk.icon className="h-3 w-3" /> {risk.label}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span className="text-foreground/80">{r.requester_name}</span>
              <span>·</span>
              <span>{bizLabel(r.business_type)}</span>
              <span>·</span>
              <span>提交于 {fullTime(r.created_at)}</span>
              {r.resolved_at && (
                <>
                  <span>·</span>
                  <span>处理于 {fullTime(r.resolved_at)}</span>
                </>
              )}
            </div>
          </div>
          {canCancel && (
            <Button variant="outline" size="sm" className="shrink-0" disabled={cancelMut.isPending} onClick={onCancel}>
              {cancelMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "撤销申请"}
            </Button>
          )}
        </div>

        <Separator className="my-3" />

        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Field label="资源">
            {r.resource_type ? (
              <span>
                {resourceTypeLabel(r.resource_type)} <span className="font-mono text-xs">{r.resource_id}</span>
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="阶段进度">
            {r.current_stage < 0 ? "已结束" : `第 ${r.current_stage + 1} / ${r.total_stages} 级`}
          </Field>
          <Field label="客户端 IP">
            <span className="font-mono text-xs">{r.client_ip || "—"}</span>
          </Field>
          <Field label="申请窗口" className="col-span-2 sm:col-span-3">
            <span className="text-xs">
              {fullTime(r.window_start)} → {fullTime(r.window_end)}
              {r.effective_window_end && r.effective_window_end !== r.window_end && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">（实际到 {fullTime(r.effective_window_end)}）</span>
              )}
            </span>
          </Field>
        </div>

        {r.reason && (
          <>
            <Separator className="my-3" />
            <div>
              <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                <FileText className="h-3 w-3" /> 申请事由
              </div>
              <p className="whitespace-pre-wrap text-sm">{r.reason}</p>
            </div>
          </>
        )}
      </div>

      {/* my decision */}
      {myTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserCheck className="h-4 w-4 text-primary" /> 等待你处理
          </div>
          {myTasks.map((t) => (
            <DecisionPanel key={t.id} task={t} onDone={() => detailQ.refetch()} />
          ))}
        </div>
      )}

      {/* grant */}
      {grant && (
        <div className="space-y-2">
          <div className="eyebrow">已发放授权</div>
          <GrantCard
            grant={
              {
                ...grant,
                request_title: r.title,
                request_reason: r.reason,
                beneficiary_name: r.requester_name,
              } as ApprovalGrantRow
            }
            mode={me?.uid === grant.beneficiary_id ? "self" : "admin"}
            readOnly={!(me?.uid === grant.beneficiary_id || access.isAdmin)}
            onChanged={() => detailQ.refetch()}
          />
        </div>
      )}

      {/* flow + ledger */}
      <Tabs defaultValue="flow">
        <TabsList>
          <TabsTrigger value="flow">审批流</TabsTrigger>
          <TabsTrigger value="ledger">审计账本（{events.length}）</TabsTrigger>
        </TabsList>
        <TabsContent value="flow" className="mt-3 rounded-xl border bg-card p-4">
          <StageStepper tasks={tasks} totalStages={r.total_stages} meUid={me?.uid} />
        </TabsContent>
        <TabsContent value="ledger" className="mt-3 space-y-2">
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 p-2.5">
            <p className="text-xs text-muted-foreground">
              每条事件用 SHA-256 串联上一条，任意改动都会让后续整条链失效。
            </p>
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              校验完整性
            </Button>
          </div>
          {events.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">尚无事件</div>
          ) : (
            <ol className="space-y-1.5">
              {events.map((e) => (
                <li key={e.id} className="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium">{eventLabel(e.kind)}</span>
                      {e.actor_name && <span className="text-xs text-muted-foreground">by {e.actor_name}</span>}
                      {e.signature && (
                        <Badge variant="secondary" className="gap-1 text-[10px]">
                          <Hash className="h-3 w-3" /> KMS 签名
                        </Badge>
                      )}
                    </div>
                    {e.payload && <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{e.payload}</p>}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground" title={fullTime(e.created_at)}>
                    {relTime(e.created_at)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {grant && (
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
              <span>Grant ID</span>
              <code className="font-mono">{grant.id}</code>
              <CopyButton value={grant.id} />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function BackLink() {
  return (
    <Link href="/approvals" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" /> 返回审批中心
    </Link>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  )
}
