"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Lock, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { EmptyState } from "@/components/common/empty-state"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "@/components/ui/sonner"
import { accessRuleService } from "@/lib/api/services"
import { useAccess } from "@/lib/hooks/use-access"
import { useEdition } from "@/lib/hooks/use-edition"
import { cn } from "@/lib/utils"
import type { AccessRule, AccessRuleKind, AccessRuleScope } from "@/lib/api/types"
import { AccessRuleSheet } from "./access-rule-sheet"
import { ACTION_META, KIND_META } from "./meta"

function scopeSummary(json: string | undefined, allLabel: string): string {
  if (!json || !json.trim()) return allLabel
  try {
    const s = JSON.parse(json) as AccessRuleScope
    if (s.all !== false) return allLabel
    const n =
      (s.user_ids?.length ?? 0) +
      (s.group_ids?.length ?? 0) +
      (s.dept_ids?.length ?? 0) +
      (s.role_ids?.length ?? 0) +
      (s.node_ids?.length ?? 0) +
      (s.asset_group_ids?.length ?? 0) +
      (s.tag_ids?.length ?? 0) +
      (s.credential_ids?.length ?? 0)
    return n === 0 ? "无" : `指定 ${n}`
  } catch {
    return allLabel
  }
}

export function AccessRulePage({ kind }: { kind: AccessRuleKind }) {
  const meta = KIND_META[kind]
  const Icon = meta.icon
  const { isAdmin, loading: accessLoading } = useAccess()
  const { has } = useEdition()
  const qc = useQueryClient()
  const [editing, setEditing] = React.useState<AccessRule | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [deleting, setDeleting] = React.useState<AccessRule | null>(null)

  const licensed = !meta.feature || has(meta.feature)
  const q = useQuery({
    queryKey: ["access-rules", kind],
    queryFn: () => accessRuleService.list(kind),
    enabled: licensed,
  })
  const rules = q.data?.rules ?? []

  const toggle = useMutation({
    mutationFn: (r: AccessRule) =>
      accessRuleService.update(r.id, {
        kind: r.kind,
        name: r.name,
        description: r.description,
        priority: r.priority,
        active: !r.active,
        users: r.users,
        assets: r.assets,
        accounts: r.accounts,
        ip_rule: r.ip_rule,
        time_window: r.time_window,
        action: r.action,
        spec: r.spec,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access-rules", kind] }),
    onError: (e: unknown) => toast.error("操作失败", { description: e instanceof Error ? e.message : String(e) }),
  })

  const del = useMutation({
    mutationFn: (r: AccessRule) => accessRuleService.remove(r.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["access-rules", kind] })
      toast.success("规则已删除")
      setDeleting(null)
    },
    onError: (e: unknown) => toast.error("删除失败", { description: e instanceof Error ? e.message : String(e) }),
  })

  if (accessLoading) return null
  if (!isAdmin) return <div className="p-6 text-sm text-muted-foreground">需要管理员权限。</div>

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <p className="eyebrow">访问控制</p>
            <h1 className="text-2xl font-semibold">{meta.title}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{meta.description}</p>
          </div>
        </div>
        {licensed && (
          <Button onClick={() => setCreating(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> 新建规则
          </Button>
        )}
      </header>

      {!licensed ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={Lock}
            title="该功能需要更高版本授权"
            description="资产连接复核为企业版功能,数据脱敏与连接方式为旗舰版功能。导入授权后即可启用。"
            action={
              <Button asChild variant="outline">
                <Link href="/admin/edition">前往版本与授权</Link>
              </Button>
            }
          />
        </div>
      ) : q.isLoading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" /> 加载中…
        </div>
      ) : rules.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={Plus}
            title="还没有规则"
            description="创建第一条规则:按用户/资产/账号匹配,命中后执行动作。优先级小者先匹配。"
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> 新建规则
              </Button>
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr className="[&>th]:px-4 [&>th]:py-2.5 [&>th]:text-left [&>th]:font-medium">
                <th className="w-16">优先级</th>
                <th>名称</th>
                <th>用户</th>
                <th>资产</th>
                <th>账号</th>
                <th>动作</th>
                <th className="w-20">启用</th>
                <th className="w-24 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rules.map((r) => {
                const am = ACTION_META[r.action]
                return (
                  <tr key={r.id} className={cn("[&>td]:px-4 [&>td]:py-2.5", !r.active && "opacity-55")}>
                    <td className="tabular-nums text-muted-foreground">{r.priority}</td>
                    <td>
                      <div className="font-medium">{r.name}</div>
                      {r.description && <div className="truncate text-xs text-muted-foreground">{r.description}</div>}
                    </td>
                    <td className="text-xs text-muted-foreground">{scopeSummary(r.users, "所有用户")}</td>
                    <td className="text-xs text-muted-foreground">{scopeSummary(r.assets, "所有资产")}</td>
                    <td className="text-xs text-muted-foreground">{scopeSummary(r.accounts, "所有账号")}</td>
                    <td>
                      <Badge variant={am.variant} className="font-normal">
                        {am.label}
                      </Badge>
                    </td>
                    <td>
                      <Switch checked={r.active} onCheckedChange={() => toggle.mutate(r)} disabled={toggle.isPending} />
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-0.5">
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="编辑" onClick={() => setEditing(r)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="删除"
                          disabled={r.is_system}
                          onClick={() => setDeleting(r)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* create / edit */}
      <AccessRuleSheet
        kind={kind}
        open={creating}
        onOpenChange={setCreating}
        onSaved={() => q.refetch()}
      />
      <AccessRuleSheet
        kind={kind}
        rule={editing}
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        onSaved={() => q.refetch()}
      />

      {deleting && (
        <AlertDialog open onOpenChange={(v) => !v && setDeleting(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-destructive" />
                删除规则「{deleting.name}」？
              </AlertDialogTitle>
              <AlertDialogDescription>删除后该规则立即不再生效。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)} disabled={del.isPending}>
                取消
              </Button>
              <Button
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={del.isPending}
                onClick={() => del.mutate(deleting)}
              >
                {del.isPending && <Spinner className="h-4 w-4" />}
                删除
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
