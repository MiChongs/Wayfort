"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  Bell,
  CheckCircle2,
  Clock,
  GitBranch,
  KeyRound,
  Pencil,
  Plus,
  ScrollText,
  ShieldCheck,
  Timer,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EmptyState } from "@/components/common/empty-state"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { approvalService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import {
  bizLabel,
  CHANNEL_LABELS,
  riskMeta,
  STAGE_MODE_LABELS,
  statusMeta,
  formatDuration,
} from "@/lib/approvals/meta"
import { TemplateEditorSheet } from "@/components/approvals/template-editor"
import { SubscriptionEditor } from "@/components/approvals/subscription-editor"
import { GrantCard } from "@/components/approvals/grant-card"
import type { ApprovalStageMode, ApprovalSubscription, ApprovalTemplate } from "@/lib/api/types"

export default function AdminApprovalsPage() {
  return (
    <div className="space-y-5 p-6">
      <header>
        <p className="eyebrow">访问治理</p>
        <h1 className="display-title text-3xl">审批治理台</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          管理审批策略、通知渠道与已发放的访问授权，掌握全局态势。
        </p>
      </header>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" className="gap-1.5">
            <Activity className="h-4 w-4" /> 概览
          </TabsTrigger>
          <TabsTrigger value="templates" className="gap-1.5">
            <GitBranch className="h-4 w-4" /> 策略模板
          </TabsTrigger>
          <TabsTrigger value="subs" className="gap-1.5">
            <Bell className="h-4 w-4" /> 通知渠道
          </TabsTrigger>
          <TabsTrigger value="grants" className="gap-1.5">
            <KeyRound className="h-4 w-4" /> 已发放授权
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="subs" className="mt-4">
          <SubscriptionsTab />
        </TabsContent>
        <TabsContent value="grants" className="mt-4">
          <GrantsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---- overview ----

function OverviewTab() {
  const q = useQuery({ queryKey: ["approval", "stats"], queryFn: () => approvalService.stats(), refetchInterval: 30_000 })
  const s = q.data
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={Clock} label="待审批" value={s?.pending_total} accent />
        <Tile icon={ScrollText} label="今日新增" value={s?.created_today} />
        <Tile icon={CheckCircle2} label="今日办结" value={s?.resolved_today} />
        <Tile icon={KeyRound} label="生效授权" value={s?.active_grants} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="平均决策时长" icon={Timer}>
          <div className="text-3xl font-semibold tabular-nums">
            {s ? formatDuration(Math.round((s.avg_decision_min || 0) * 60)) : "—"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">从提交到办结的平均耗时（近 500 条）。</p>
        </Panel>
        <Panel title="按状态分布" icon={Activity} className="lg:col-span-2">
          <Distribution
            data={s?.status_counts}
            render={(k) => ({ label: statusMeta(k).label, dot: statusMeta(k).dot })}
          />
        </Panel>
        <Panel title="按风险分布" icon={ShieldCheck}>
          <Distribution data={s?.risk_counts} render={(k) => ({ label: riskMeta(k).label, dot: riskMeta(k).dot })} />
        </Panel>
        <Panel title="按业务类型分布" icon={GitBranch} className="lg:col-span-2">
          <Distribution data={s?.business_counts} render={(k) => ({ label: bizLabel(k), dot: "bg-primary/60" })} />
        </Panel>
      </div>
    </div>
  )
}

function Tile({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: number
  accent?: boolean
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
      <span className={cn("grid h-10 w-10 place-items-center rounded-lg", accent ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <div className="text-2xl font-semibold tabular-nums leading-none">{value ?? "—"}</div>
        <div className="mt-1 text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

function Panel({
  title,
  icon: Icon,
  className,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4", className)}>
      <div className="mb-3 flex items-center gap-1.5 text-sm font-medium">
        <Icon className="h-4 w-4 text-muted-foreground" /> {title}
      </div>
      {children}
    </div>
  )
}

function Distribution({
  data,
  render,
}: {
  data?: Record<string, number>
  render: (key: string) => { label: string; dot: string }
}) {
  const entries = Object.entries(data ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((acc, [, n]) => acc + n, 0)
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">暂无数据</p>
  return (
    <div className="space-y-2">
      {entries.map(([k, n]) => {
        const meta = render(k)
        const pct = total > 0 ? (n / total) * 100 : 0
        return (
          <div key={k} className="flex items-center gap-2 text-sm">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", meta.dot)} />
            <span className="w-24 shrink-0 truncate text-xs">{meta.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", meta.dot)} style={{ width: `${pct}%` }} />
            </div>
            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{n}</span>
          </div>
        )
      })}
    </div>
  )
}

// ---- templates ----

function templateToBody(t: ApprovalTemplate) {
  return {
    name: t.name,
    description: t.description,
    business_type: t.business_type,
    priority: t.priority,
    enabled: t.enabled,
    selector: t.selector,
    stages: t.stages,
    risk_rule: t.risk_rule,
    auto_approve: t.auto_approve,
    max_duration_sec: t.max_duration_sec,
    default_timeout_sec: t.default_timeout_sec,
  }
}

function stagesSummary(stagesJSON: string): string {
  try {
    const stages = JSON.parse(stagesJSON || "[]") as { mode: ApprovalStageMode; role_names?: string[] }[]
    if (!stages.length) return "自动通过 / 无审批阶段"
    return stages
      .map((s, i) => `第${i + 1}级 ${STAGE_MODE_LABELS[s.mode] ?? s.mode}${s.role_names?.length ? `·${s.role_names.join("/")}` : ""}`)
      .join(" → ")
  } catch {
    return "—"
  }
}

function TemplatesTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["approval", "templates"], queryFn: () => approvalService.templates.list() })
  const [editing, setEditing] = React.useState<ApprovalTemplate | null>(null)
  const [open, setOpen] = React.useState(false)

  const remove = useMutation({
    mutationFn: (id: number) => approvalService.templates.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approval", "templates"] }),
  })
  const toggle = useMutation({
    mutationFn: (t: ApprovalTemplate) => approvalService.templates.update(t.id, { ...templateToBody(t), enabled: !t.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approval", "templates"] }),
  })

  const items = q.data?.items ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">命中的请求按优先级（小者优先）选用第一条匹配的模板。</p>
        <Button
          className="gap-1.5"
          onClick={() => {
            setEditing(null)
            setOpen(true)
          }}
        >
          <Plus className="h-4 w-4" /> 新建模板
        </Button>
      </div>

      {q.isLoading ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <EmptyState icon={GitBranch} title="还没有模板" description="新建一条审批策略来路由请求。" />
      ) : (
        <div className="space-y-2">
          {items.map((t) => (
            <div key={t.id} className="rounded-xl border bg-card p-3.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{t.name}</span>
                    <Badge variant="outline" className="text-[11px]">{bizLabel(t.business_type)}</Badge>
                    {t.is_system && <Badge variant="secondary" className="text-[11px]">内置</Badge>}
                    <span className="text-xs text-muted-foreground">优先级 {t.priority}</span>
                  </div>
                  {t.description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.description}</p>}
                  <p className="mt-1 truncate text-xs text-muted-foreground">{stagesSummary(t.stages)}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    授权上限 {t.max_duration_sec ? formatDuration(t.max_duration_sec) : "不限"}
                    {t.default_timeout_sec ? ` · 单级超时 ${formatDuration(t.default_timeout_sec)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch checked={t.enabled} onCheckedChange={() => toggle.mutate(t)} />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setEditing(t)
                      setOpen(true)
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {!t.is_system && (
                    <ConfirmDeleteIconButton
                      title={`删除模板 “${t.name}”？`}
                      description="使用该模板的业务将回退到其它匹配模板；若无匹配，新请求会被拒绝。"
                      loading={remove.isPending}
                      onConfirm={() => remove.mutate(t.id)}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <TemplateEditorSheet open={open} onOpenChange={setOpen} template={editing} onSaved={() => q.refetch()} />
    </div>
  )
}

// ---- subscriptions ----

function SubscriptionsTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["approval", "subscriptions"], queryFn: () => approvalService.subscriptions.list() })
  const [editing, setEditing] = React.useState<ApprovalSubscription | null>(null)
  const [open, setOpen] = React.useState(false)

  const remove = useMutation({
    mutationFn: (id: number) => approvalService.subscriptions.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approval", "subscriptions"] }),
  })

  const items = q.data?.items ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">审批事件实时推送到 IM / Webhook / SIEM。</p>
        <Button
          className="gap-1.5"
          onClick={() => {
            setEditing(null)
            setOpen(true)
          }}
        >
          <Plus className="h-4 w-4" /> 新增渠道
        </Button>
      </div>

      {q.isLoading ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <EmptyState icon={Bell} title="还没有通知渠道" description="添加飞书 / 钉钉 / 企业微信 / Webhook 等渠道，接收审批动态。" />
      ) : (
        <div className="space-y-2">
          {items.map((sub) => (
            <div key={sub.id} className="flex items-start gap-3 rounded-xl border bg-card p-3.5">
              <span className={cn("mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg", sub.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                <Bell className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{sub.name}</span>
                  <Badge variant="outline" className="text-[11px]">{CHANNEL_LABELS[sub.channel] ?? sub.channel}</Badge>
                  {!sub.enabled && <Badge variant="secondary" className="text-[11px]">已停用</Badge>}
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{sub.target}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {sub.business_type ? bizLabel(sub.business_type) : "全部业务"}
                  {sub.event_mask ? ` · ${sub.event_mask.split(",").length} 类事件` : " · 全部事件"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setEditing(sub)
                    setOpen(true)
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <ConfirmDeleteIconButton
                  title={`删除渠道 “${sub.name}”？`}
                  description="删除后将不再向该渠道推送审批事件。"
                  loading={remove.isPending}
                  onConfirm={() => remove.mutate(sub.id)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <SubscriptionEditor open={open} onOpenChange={setOpen} subscription={editing} onSaved={() => q.refetch()} />
    </div>
  )
}

// ---- grants ----

function GrantsTab() {
  const [status, setStatus] = React.useState("active")
  const q = useQuery({
    queryKey: ["approval", "grants", status],
    queryFn: () => approvalService.grants({ status, limit: 200 }),
    refetchInterval: 30_000,
  })
  const items = q.data?.items ?? []
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">所有用户当前持有的访问授权，可随时收回。</p>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">生效中</SelectItem>
            <SelectItem value="active,expired,revoked,used_up">全部状态</SelectItem>
            <SelectItem value="revoked">已收回</SelectItem>
            <SelectItem value="expired">已到期</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {q.isLoading ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <EmptyState icon={KeyRound} title="没有授权" description="审批通过后发放的授权会显示在这里。" />
      ) : (
        <div className="space-y-2">
          {items.map((g) => (
            <GrantCard key={g.id} grant={g} mode="admin" onChanged={() => q.refetch()} />
          ))}
        </div>
      )}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl border bg-muted/40" />
      ))}
    </div>
  )
}
