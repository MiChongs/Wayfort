"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { KeyRound, Loader2, ShieldOff } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { approvalService } from "@/lib/api/services"
import type { ApprovalGrantRow } from "@/lib/api/types"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { BIZ_ICONS, bizLabel, grantStatusMeta, resourceTypeLabel } from "@/lib/approvals/meta"

// GrantCard — one issued grant, rendered for either the beneficiary ("我的授权",
// mode=self → 提前结束) or an admin ("治理 → 收回"). Shows a live time-remaining
// bar so a soon-to-expire grant is obvious at a glance.
export function GrantCard({
  grant,
  mode,
  onChanged,
  readOnly,
}: {
  grant: ApprovalGrantRow
  mode: "self" | "admin"
  onChanged: () => void
  /** Hide the end/revoke affordance (e.g. an approver viewing someone else's grant). */
  readOnly?: boolean
}) {
  const Icon = BIZ_ICONS[grant.business_type] ?? KeyRound
  const sm = grantStatusMeta(grant.status)
  const active = grant.status === "active"

  const start = Date.parse(grant.not_before)
  const end = Date.parse(grant.not_after)
  const now = Date.now()
  const pct = active && end > start ? Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100)) : 100
  const soon = active && end - now < 30 * 60 * 1000 // < 30 min remaining

  const release = useMutation({
    mutationFn: () =>
      mode === "admin"
        ? approvalService.revokeGrant(grant.id, "管理员收回")
        : approvalService.releaseGrant(grant.id),
    onSuccess: () => {
      toast.success(mode === "admin" ? "已收回授权" : "已结束该授权")
      onChanged()
    },
    onError: (e: { message?: string }) => toast.error(e.message || "操作失败"),
  })

  const onEnd = async () => {
    const ok = await confirmDialog({
      title: mode === "admin" ? "收回这条授权？" : "提前结束这条授权？",
      description:
        mode === "admin"
          ? "被授权人将立即失去该访问权限，已建立的会话会按服务端策略中断。"
          : "结束后你将立即失去该访问权限，如需再用请重新申请。",
      destructive: true,
      confirmLabel: mode === "admin" ? "收回" : "结束",
    })
    if (ok) release.mutate()
  }

  return (
    <div className="rounded-xl border bg-card p-3.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{grant.request_title || bizLabel(grant.business_type)}</span>
            <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", sm.badge)}>
              <sm.icon className="h-3 w-3" /> {sm.label}
            </span>
            {mode === "admin" && (
              <span className="text-xs text-muted-foreground">· {grant.beneficiary_name || `用户 #${grant.beneficiary_id}`}</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {bizLabel(grant.business_type)}
            {grant.resource_type && (
              <>
                {" · "}
                {resourceTypeLabel(grant.resource_type)} {grant.resource_id}
              </>
            )}
            {grant.actions && <> · 权限 {grant.actions}</>}
          </div>
        </div>
        {active && !readOnly && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1 text-destructive"
            disabled={release.isPending}
            onClick={onEnd}
          >
            {release.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
            {mode === "admin" ? "收回" : "结束"}
          </Button>
        )}
      </div>

      {active ? (
        <div className="mt-3 space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", soon ? "bg-amber-500" : "bg-primary")}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>有效至 {fullTime(grant.not_after)}</span>
            <span className={cn(soon && "text-amber-600 dark:text-amber-400")}>{relTime(grant.not_after)}到期</span>
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {grant.status === "revoked" && grant.revoke_reason ? `已收回 · ${grant.revoke_reason}` : `有效期至 ${fullTime(grant.not_after)}`}
        </div>
      )}
    </div>
  )
}
