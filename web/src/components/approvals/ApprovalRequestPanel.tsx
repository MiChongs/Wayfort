"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Check, Clock, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { approvalService } from "@/lib/api/services"
import { useApprovalStream } from "@/lib/hooks/use-approval-stream"
import { relTime, fullTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { eventLabel, riskMeta } from "@/lib/approvals/meta"
import type { ApprovalBusinessType } from "@/lib/api/types"

const DURATIONS = [
  { label: "1 小时", sec: 3600 },
  { label: "4 小时", sec: 4 * 3600 },
  { label: "8 小时", sec: 8 * 3600 },
]

export interface ApprovalRequestPanelProps {
  resourceId: string
  resourceType?: string
  businessType?: ApprovalBusinessType
  action?: string
  /** Display name of the target (node name). */
  title: string
  /** Secondary line, e.g. "ssh · 10.0.0.5:22". */
  subtitle?: string
  /** Resume an in-flight request instead of showing the apply form. */
  existingRequestId?: string
  /** Fired once when the request reaches approved / auto_approved. */
  onApproved: () => void
  className?: string
}

export function ApprovalRequestPanel({
  resourceId,
  resourceType = "node",
  businessType = "asset_access",
  action = "connect",
  title,
  subtitle,
  existingRequestId,
  onApproved,
  className,
}: ApprovalRequestPanelProps) {
  const [requestId, setRequestId] = React.useState<string | undefined>(existingRequestId)
  const [reason, setReason] = React.useState("")
  const [durationSec, setDurationSec] = React.useState(4 * 3600)
  const [customHours, setCustomHours] = React.useState("")

  const create = useMutation({
    mutationFn: () =>
      approvalService.create({
        business_type: businessType,
        title: `访问 ${title}`,
        reason: reason.trim(),
        resource_type: resourceType,
        resource_id: resourceId,
        payload: { action },
        window_end: new Date(Date.now() + durationSec * 1000).toISOString(),
      }),
    onSuccess: (out) => {
      if (out.auto_approved) {
        toast.success("已自动通过，正在连接")
        onApproved()
        return
      }
      setRequestId(out.request.id)
    },
    onError: (e: unknown) => toast.error("提交失败", { description: (e as Error).message }),
  })

  if (!requestId) {
    return (
      <ApplyForm
        title={title}
        subtitle={subtitle}
        reason={reason}
        setReason={setReason}
        durationSec={durationSec}
        setDurationSec={setDurationSec}
        customHours={customHours}
        setCustomHours={setCustomHours}
        pending={create.isPending}
        onSubmit={() => create.mutate()}
        className={className}
      />
    )
  }

  return (
    <StatusView
      requestId={requestId}
      title={title}
      subtitle={subtitle}
      onApproved={onApproved}
      onReapply={() => {
        setRequestId(undefined)
        setReason("")
      }}
      className={className}
    />
  )
}

function ApplyForm({
  title,
  subtitle,
  reason,
  setReason,
  durationSec,
  setDurationSec,
  customHours,
  setCustomHours,
  pending,
  onSubmit,
  className,
}: {
  title: string
  subtitle?: string
  reason: string
  setReason: (v: string) => void
  durationSec: number
  setDurationSec: (v: number) => void
  customHours: string
  setCustomHours: (v: string) => void
  pending: boolean
  onSubmit: () => void
  className?: string
}) {
  const customActive = !DURATIONS.some((d) => d.sec === durationSec)
  return (
    <div className={cn("mx-auto flex w-full max-w-md flex-col items-center px-6 py-10", className)}>
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <ShieldAlert className="h-6 w-6" />
      </span>
      <h2 className="mt-4 text-lg font-semibold tracking-tight">连接需要审批</h2>
      <p className="mt-1 text-center text-sm text-muted-foreground">
        访问 <span className="font-medium text-foreground">{title}</span> 已开启审批控制。提交申请，审批通过后将自动建立连接。
      </p>
      {subtitle && <p className="mt-0.5 font-mono text-xs text-muted-foreground">{subtitle}</p>}

      <div className="mt-6 w-full space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs">申请事由</Label>
          <Textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="说明本次访问的用途，便于审批人判断"
            className="min-h-[80px] resize-none"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">有效时长</Label>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => (
              <button
                key={d.sec}
                type="button"
                onClick={() => setDurationSec(d.sec)}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                  durationSec === d.sec ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent",
                )}
              >
                {d.label}
              </button>
            ))}
            <div
              className={cn(
                "flex items-center gap-1 rounded-lg border px-2 py-1 text-sm transition-colors",
                customActive ? "border-primary bg-primary/10" : "",
              )}
            >
              <Input
                value={customHours}
                onChange={(e) => {
                  setCustomHours(e.target.value)
                  const h = Number(e.target.value)
                  if (h > 0) setDurationSec(Math.round(h * 3600))
                }}
                inputMode="numeric"
                placeholder="自定义"
                className="h-7 w-16 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
              />
              <span className="pr-1 text-xs text-muted-foreground">小时</span>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">通过后，授权将在该时长内有效。</p>
        </div>
        <Button className="w-full" disabled={pending} onClick={onSubmit}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          提交申请
        </Button>
      </div>
    </div>
  )
}

function StatusView({
  requestId,
  title,
  subtitle,
  onApproved,
  onReapply,
  className,
}: {
  requestId: string
  title: string
  subtitle?: string
  onApproved: () => void
  onReapply: () => void
  className?: string
}) {
  const q = useApprovalStream(requestId)
  const detail = q.data
  const status = detail?.request.status
  const firedRef = React.useRef(false)

  React.useEffect(() => {
    if ((status === "approved" || status === "auto_approved") && !firedRef.current) {
      firedRef.current = true
      onApproved()
    }
  }, [status, onApproved])

  const cancel = useMutation({
    mutationFn: () => approvalService.cancel(requestId, "用户撤销"),
    onSuccess: () => toast.success("已撤销申请"),
    onError: (e: unknown) => toast.error("撤销失败", { description: (e as Error).message }),
  })

  if (q.isLoading || !detail) {
    return (
      <div className={cn("grid place-items-center p-10 text-sm text-muted-foreground", className)}>
        <Loader2 className="mb-2 h-5 w-5 animate-spin" /> 读取审批状态…
      </div>
    )
  }

  const req = detail.request
  const pendingApprovers = detail.tasks.filter((t) => t.state === "pending").length
  const rejected = detail.tasks.find((t) => t.state === "rejected")

  if (status === "approved" || status === "auto_approved") {
    return (
      <Outcome
        tone="ok"
        icon={ShieldCheck}
        title="审批已通过"
        desc="正在建立连接…"
        className={className}
      />
    )
  }
  if (status === "rejected") {
    return (
      <Outcome
        tone="bad"
        icon={X}
        title="申请被驳回"
        desc={rejected?.comment || "审批人未通过本次申请。"}
        action={<Button variant="outline" onClick={onReapply}>重新申请</Button>}
        className={className}
      />
    )
  }
  if (status === "cancelled" || status === "expired") {
    return (
      <Outcome
        tone="muted"
        icon={Clock}
        title={status === "expired" ? "申请已超时" : "申请已撤销"}
        desc="可重新发起申请。"
        action={<Button variant="outline" onClick={onReapply}>重新申请</Button>}
        className={className}
      />
    )
  }

  // pending
  const risk = riskMeta(req.risk_level)
  return (
    <div className={cn("mx-auto flex w-full max-w-lg flex-col px-6 py-10", className)}>
      <div className="flex items-center gap-3">
        <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Clock className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">等待审批</h2>
          <p className="truncate text-sm text-muted-foreground">
            {title}
            {subtitle ? ` · ${subtitle}` : ""}
          </p>
        </div>
        <span className="flex-1" />
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", risk.badge)}>{risk.label}</span>
      </div>

      <div className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-500" />
        <span>
          {req.total_stages > 1
            ? `审批进度 第 ${Math.min(req.current_stage + 1, req.total_stages)} / ${req.total_stages} 级`
            : "已提交，等待审批人处理"}
          {pendingApprovers > 0 && ` · 待 ${pendingApprovers} 人处理`}
        </span>
      </div>

      {req.reason && (
        <div className="mt-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
          <div className="mb-1 text-xs text-muted-foreground">申请事由</div>
          {req.reason}
        </div>
      )}

      {/* Timeline */}
      <div className="mt-4">
        <div className="mb-2 text-xs text-muted-foreground">处理记录</div>
        <ol className="space-y-2.5">
          {[...detail.events].reverse().map((ev) => (
            <li key={ev.id} className="flex items-start gap-2.5 text-sm">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
              <div className="min-w-0 flex-1">
                <span>{eventLabel(ev.kind)}</span>
                {ev.actor_name && <span className="text-muted-foreground"> · {ev.actor_name}</span>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground" title={fullTime(ev.created_at)}>
                {relTime(ev.created_at)}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-6 flex justify-end">
        <Button
          variant="outline"
          disabled={cancel.isPending}
          onClick={async () => {
            const ok = await confirmDialog({ title: "撤销这条申请？", description: "撤销后需重新发起。" })
            if (ok) cancel.mutate()
          }}
        >
          撤销申请
        </Button>
      </div>
    </div>
  )
}

function Outcome({
  tone,
  icon: Icon,
  title,
  desc,
  action,
  className,
}: {
  tone: "ok" | "bad" | "muted"
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
  action?: React.ReactNode
  className?: string
}) {
  const cls = {
    ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    bad: "bg-destructive/10 text-destructive",
    muted: "bg-muted text-muted-foreground",
  }[tone]
  return (
    <div className={cn("mx-auto flex w-full max-w-md flex-col items-center px-6 py-12 text-center", className)}>
      <span className={cn("grid h-12 w-12 place-items-center rounded-2xl", cls)}>
        <Icon className="h-6 w-6" />
      </span>
      <h2 className="mt-4 text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
