"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { AlertTriangle, ListChecks, ServerCog, Ticket } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { UserAvatar } from "@/components/common/user-avatar"
import { toast } from "@/components/ui/sonner"
import { breakGlassService } from "@/lib/api/services"
import { bgModeMeta, bgStatusMeta, bgVerdictMeta } from "@/lib/break-glass/meta"
import { CountdownRing } from "@/components/break-glass/countdown-ring"
import { LifecycleTimeline } from "@/components/break-glass/lifecycle-timeline"
import { cn } from "@/lib/utils"
import type { BreakGlassActivation, BreakGlassReviewVerdict } from "@/lib/api/types"

function StatusBadge({ status }: { status: string }) {
  const m = bgStatusMeta(status)
  const Icon = m.icon
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", m.badge)}>
      <Icon className="h-3 w-3" />
      {m.label}
    </span>
  )
}

export function ActivationDetailSheet({
  activation,
  onClose,
  canRevoke,
  onChanged,
}: {
  activation: BreakGlassActivation | null
  onClose: () => void
  canRevoke: boolean
  onChanged: (a: BreakGlassActivation) => void
}) {
  const [revokeReason, setRevokeReason] = React.useState("")
  const [verdict, setVerdict] = React.useState<BreakGlassReviewVerdict>("justified")
  const [comment, setComment] = React.useState("")

  React.useEffect(() => {
    setRevokeReason("")
    setVerdict("justified")
    setComment("")
  }, [activation?.id])

  const revoke = useMutation({
    mutationFn: () => breakGlassService.revoke(activation!.id, revokeReason.trim()),
    onSuccess: (res) => {
      toast.success("已吊销应急访问")
      onChanged(res.activation)
    },
    onError: (e: unknown) => toast.error("吊销失败", { description: (e as Error).message }),
  })
  const review = useMutation({
    mutationFn: () => breakGlassService.review(activation!.id, verdict, comment.trim()),
    onSuccess: (res) => {
      toast.success("复核已提交")
      onChanged(res.activation)
    },
    onError: (e: unknown) => toast.error("复核失败", { description: (e as Error).message }),
  })

  const a = activation
  const mode = a ? bgModeMeta(a.mode) : null
  const verdictMeta = bgVerdictMeta(a?.review_verdict)
  const active = a?.status === "active"

  return (
    <Sheet open={!!a} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {a && (
          <>
            <SheetHeader className="border-b px-5 pb-4 pt-5">
              <SheetTitle className="flex items-center gap-2 text-base">
                <ServerCog className="h-4 w-4 text-orange-500" />
                {a.resource_name || a.resource_id}
              </SheetTitle>
              <SheetDescription>应急访问详情与处置</SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
              {/* hero: ring + key facts */}
              <div className="flex items-center gap-4 rounded-xl border bg-card p-4">
                {active ? (
                  <CountdownRing notBefore={a.activated_at} notAfter={a.not_after} size={84} />
                ) : (
                  <span className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-full bg-muted">
                    {(() => {
                      const Icon = bgStatusMeta(a.status).icon
                      return <Icon className={cn("h-8 w-8", bgStatusMeta(a.status).dot.replace("bg-", "text-"))} />
                    })()}
                  </span>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} />
                    {mode && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <mode.icon className="h-3.5 w-3.5" /> {mode.label}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <UserAvatar name={a.requester_name} size="sm" />
                    <span className="text-sm font-medium">{a.requester_name}</span>
                  </div>
                  {a.incident_ref && (
                    <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Ticket className="h-3.5 w-3.5" /> {a.incident_ref}
                    </div>
                  )}
                </div>
              </div>

              {/* justification callout */}
              <div className="rounded-lg border-l-2 border-orange-400 bg-orange-500/5 px-3 py-2.5">
                <div className="text-xs font-medium text-muted-foreground">申请理由</div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{a.justification}</p>
              </div>

              {/* lifecycle */}
              <div>
                <div className="mb-3 text-xs font-medium text-muted-foreground">生命周期</div>
                <LifecycleTimeline activation={a} />
              </div>

              {/* policy / ip footnote */}
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <span>策略：{a.policy_name || "—"}</span>
                <span>来源 IP：{a.client_ip || "—"}</span>
              </div>

              {/* review outcome */}
              {a.reviewed_at && verdictMeta && (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">复核结论</span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                        verdictMeta.badge,
                      )}
                    >
                      <verdictMeta.icon className="h-3 w-3" />
                      {verdictMeta.label}
                    </span>
                    <span className="text-xs text-muted-foreground">· {a.reviewer_name}</span>
                  </div>
                  {a.review_comment && <p className="mt-1.5 text-sm">{a.review_comment}</p>}
                </div>
              )}

              {/* kill-switch */}
              {(a.status === "active" || a.status === "pending") && canRevoke && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                    <AlertTriangle className="h-4 w-4" /> 立即吊销（kill-switch）
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">立即回收访问授权并强制断开正在进行的会话。</p>
                  <Textarea
                    value={revokeReason}
                    onChange={(e) => setRevokeReason(e.target.value)}
                    placeholder="吊销原因（必填）"
                    rows={2}
                    className="mt-2"
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    className="mt-2"
                    disabled={!revokeReason.trim() || revoke.isPending}
                    onClick={() => revoke.mutate()}
                  >
                    {revoke.isPending && <Spinner className="mr-2 h-3.5 w-3.5" />}
                    确认吊销
                  </Button>
                </div>
              )}

              {/* review form */}
              {a.status === "under_review" && (
                <div className="rounded-lg border bg-sky-500/5 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <ListChecks className="h-4 w-4 text-sky-500" /> 事后复核
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">复核人不能是申请人本人；提交后闭环。</p>
                  <div className="mt-2 space-y-2">
                    <Select value={verdict} onValueChange={(v) => setVerdict(v as BreakGlassReviewVerdict)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="justified">正当 — 访问合理</SelectItem>
                        <SelectItem value="unjustified">不正当 — 需追责</SelectItem>
                        <SelectItem value="inconclusive">存疑 — 需进一步核查</SelectItem>
                      </SelectContent>
                    </Select>
                    <Textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="复核意见（必填）"
                      rows={3}
                    />
                    <Button size="sm" disabled={!comment.trim() || review.isPending} onClick={() => review.mutate()}>
                      {review.isPending && <Spinner className="mr-2 h-3.5 w-3.5" />}
                      提交复核
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
