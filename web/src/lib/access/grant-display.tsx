"use client"

// Shared grant-display primitives, extracted from the 访问策略 page so the
// overview table, the 按人看 access tree, and the node detail panel all render
// permissions / expiry / grantee names identically.

import * as React from "react"
import { CalendarClock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { actionLabel } from "@/lib/access/permissions"
import type { GranteeKind } from "@/lib/api/types"

export const GRANTEE_KIND_LABEL: Record<GranteeKind, string> = {
  user: "用户",
  role: "角色",
  group: "用户组",
  department: "部门",
}

// Why a grantee can reach a subject (the grant's subject_type).
export const VIA_LABEL: Record<string, string> = {
  node: "直接授权",
  group: "资产组",
  tag: "标签",
  all: "全部资产",
  department: "部门",
}

// A minimal name resolver — pass a (type,id) → name function so callers keep
// owning their directory; falls back to a "<kind>#id" label.
export type GranteeNameFn = (type: GranteeKind, id: number) => string

export function granteeNameFrom(
  lookup: (type: GranteeKind, id: number) => string | undefined,
): GranteeNameFn {
  return (type, id) => lookup(type, id) ?? `${GRANTEE_KIND_LABEL[type]}#${id}`
}

export function ActionChips({ actions, className }: { actions: string[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {actions.map((a) => (
        <Badge key={a} variant={a === "*" ? "secondary" : "outline"} className="font-normal">
          {actionLabel(a)}
        </Badge>
      ))}
    </div>
  )
}

// ValidityCell renders a grant's expiry as warm-semantic text: muted "永久",
// a warning chip when expiring within 3 days, a destructive chip once expired.
export function ValidityCell({ to, className }: { to?: string | null; className?: string }) {
  if (!to) return <span className={cn("text-muted-foreground", className)}>永久</span>
  const ms = new Date(to).getTime() - Date.now()
  if (ms <= 0)
    return (
      <Badge variant="outline" className={cn("border-destructive/30 bg-destructive/10 font-normal text-destructive", className)}>
        已过期
      </Badge>
    )
  const days = Math.ceil(ms / 86400000)
  const soon = days <= 3
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", soon ? "text-warning" : "text-muted-foreground", className)}>
      <CalendarClock className="h-3.5 w-3.5" />
      {days <= 1 ? "今天到期" : `${days} 天后到期`}
    </span>
  )
}
