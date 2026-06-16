"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  AlertTriangle,
  Clock,
  FileWarning,
  LifeBuoy,
  ListChecks,
  Plus,
  ScrollText,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EmptyState } from "@/components/common/empty-state"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { toast } from "@/components/ui/sonner"
import { breakGlassService } from "@/lib/api/services"
import { useAccess } from "@/lib/hooks/use-access"
import { cn } from "@/lib/utils"
import { bgModeMeta, bgStatusMeta, BG_SCOPE_LABELS } from "@/lib/break-glass/meta"
import { EmergencyAccessDialog } from "@/components/break-glass/emergency-access-dialog"
import { ActivationDetailSheet } from "@/components/break-glass/activation-detail-sheet"
import { LiveRemaining } from "@/components/break-glass/countdown-ring"
import { UserAvatar } from "@/components/common/user-avatar"
import type {
  BreakGlassActivation,
  BreakGlassPolicy,
  BreakGlassReviewVerdict,
} from "@/lib/api/types"

function fmt(ts?: string | null): string {
  if (!ts) return "—"
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("zh-CN", { hour12: false })
}

function StatusBadge({ status }: { status: string }) {
  const m = bgStatusMeta(status)
  const Icon = m.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        m.badge,
      )}
    >
      <Icon className="h-3 w-3" />
      {m.label}
    </span>
  )
}

export default function BreakGlassGovernancePage() {
  const access = useAccess()
  const canRevoke = access.isSuperadmin || access.permissions.includes("system:admin")
  const [activateOpen, setActivateOpen] = React.useState(false)
  const [detail, setDetail] = React.useState<BreakGlassActivation | null>(null)
  const qc = useQueryClient()

  const invalidate = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["break-glass"] })
  }, [qc])

  return (
    <div className="space-y-5 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">访问治理</p>
          <h1 className="text-2xl font-semibold">应急访问 break-glass</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            紧急情况下的受控快速通道：每次激活全程审计、即时通知安全团队、强制录制并要求事后复核。
          </p>
        </div>
        <Button onClick={() => setActivateOpen(true)} className="gap-1.5">
          <LifeBuoy className="h-4 w-4" /> 发起应急访问
        </Button>
      </header>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" className="gap-1.5">
            <Activity className="h-4 w-4" /> 概览
          </TabsTrigger>
          <TabsTrigger value="activations" className="gap-1.5">
            <ScrollText className="h-4 w-4" /> 激活记录
          </TabsTrigger>
          <TabsTrigger value="reviews" className="gap-1.5">
            <ListChecks className="h-4 w-4" /> 待复核
          </TabsTrigger>
          <TabsTrigger value="policies" className="gap-1.5">
            <ShieldCheck className="h-4 w-4" /> 策略
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="activations" className="mt-4">
          <ActivationsTab onOpen={setDetail} />
        </TabsContent>
        <TabsContent value="reviews" className="mt-4">
          <ReviewsTab onOpen={setDetail} />
        </TabsContent>
        <TabsContent value="policies" className="mt-4">
          <PoliciesTab />
        </TabsContent>
      </Tabs>

      <EmergencyAccessDialog
        open={activateOpen}
        onOpenChange={setActivateOpen}
        onActivated={invalidate}
      />

      <ActivationDetailSheet
        activation={detail}
        onClose={() => setDetail(null)}
        canRevoke={canRevoke}
        onChanged={(a) => {
          setDetail(a)
          invalidate()
        }}
      />
    </div>
  )
}

// ----- Overview -----

function Tile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ElementType
  label: string
  value: number | string
  tone?: string
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className={cn("h-4 w-4", tone)} />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function OverviewTab() {
  const q = useQuery({
    queryKey: ["break-glass", "stats"],
    queryFn: breakGlassService.stats,
    refetchInterval: 20_000,
  })
  const s = q.data
  const active = s?.active ?? 0
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {/* hero — what's live right now */}
        <div className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-orange-500/12 to-transparent p-5">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className={cn("relative flex h-2 w-2", active > 0 && "")}>
              {active > 0 && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
              )}
              <span className={cn("relative inline-flex h-2 w-2 rounded-full", active > 0 ? "bg-orange-500" : "bg-muted-foreground/40")} />
            </span>
            进行中
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-4xl font-semibold tabular-nums text-orange-600">{active}</span>
            <span className="text-xs text-muted-foreground">个应急访问开通中</span>
          </div>
          <Zap className="pointer-events-none absolute -bottom-3 -right-2 h-20 w-20 text-orange-500/10" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          <Tile icon={Clock} label="待审批" value={s?.pending ?? 0} tone="text-amber-500" />
          <Tile icon={ListChecks} label="待复核" value={s?.under_review ?? 0} tone="text-sky-500" />
          <Tile icon={AlertTriangle} label="自助破玻璃 · 累计" value={s?.fail_open_total ?? 0} tone="text-orange-600" />
          <Tile icon={Activity} label="近 24 小时" value={s?.today ?? 0} tone="text-emerald-500" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile icon={FileWarning} label="已吊销 · 累计" value={s?.revoked_total ?? 0} tone="text-destructive" />
        <Tile icon={ScrollText} label="历史总计" value={s?.total ?? 0} tone="text-muted-foreground" />
      </div>
    </div>
  )
}

// ----- Activations list -----

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "pending", label: "待审批" },
  { value: "under_review", label: "待复核" },
  { value: "closed", label: "已闭环" },
  { value: "revoked", label: "已吊销" },
  { value: "expired", label: "已到期" },
  { value: "rejected", label: "已驳回" },
]

function ActivationRow({
  a,
  onOpen,
}: {
  a: BreakGlassActivation
  onOpen: (a: BreakGlassActivation) => void
}) {
  const mode = bgModeMeta(a.mode)
  const ModeIcon = mode.icon
  return (
    <button
      type="button"
      onClick={() => onOpen(a)}
      className="flex w-full items-center gap-3 border-b px-3 py-2.5 text-left text-sm last:border-0 hover:bg-accent/50"
    >
      <UserAvatar name={a.requester_name} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{a.resource_name || a.resource_id}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {a.requester_name} · {a.incident_ref || "无工单"} · {fmt(a.created_at)}
        </span>
      </span>
      <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
        <ModeIcon className="h-3.5 w-3.5" />
        {mode.label}
      </span>
      {a.status === "active" ? (
        <LiveRemaining notAfter={a.not_after} className="w-16 text-right text-xs font-medium" />
      ) : (
        <span className="shrink-0">
          <StatusBadge status={a.status} />
        </span>
      )}
    </button>
  )
}

function ActivationsTab({ onOpen }: { onOpen: (a: BreakGlassActivation) => void }) {
  const [status, setStatus] = React.useState("")
  const [q, setQ] = React.useState("")
  const query = useQuery({
    queryKey: ["break-glass", "activations", status, q],
    queryFn: () => breakGlassService.list({ status: status || undefined, q: q || undefined, limit: 100 }),
    refetchInterval: 20_000,
  })
  const rows = query.data?.activations ?? []
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value || "all"} value={f.value || "all"}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索申请人 / 资产 / 工单 / 理由…"
          className="max-w-xs"
        />
      </div>
      <div className="rounded-lg border">
        {query.isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Spinner className="mr-2 h-4 w-4" /> 加载中…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={ScrollText} title="暂无应急访问记录" description="当有人发起 break-glass 时会出现在这里。" />
        ) : (
          rows.map((a) => <ActivationRow key={a.id} a={a} onOpen={onOpen} />)
        )}
      </div>
    </div>
  )
}

// ----- Reviews -----

function ReviewsTab({ onOpen }: { onOpen: (a: BreakGlassActivation) => void }) {
  const query = useQuery({
    queryKey: ["break-glass", "activations", "under_review", ""],
    queryFn: () => breakGlassService.list({ status: "under_review", limit: 100 }),
    refetchInterval: 20_000,
  })
  const rows = query.data?.activations ?? []
  return (
    <div className="rounded-lg border">
      {query.isLoading ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Spinner className="mr-2 h-4 w-4" /> 加载中…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="没有待复核的应急访问"
          description="结束的应急访问会在这里等待他人复核签字才算闭环。"
        />
      ) : (
        rows.map((a) => <ActivationRow key={a.id} a={a} onOpen={onOpen} />)
      )}
    </div>
  )
}


// ----- Policies -----

function PoliciesTab() {
  const qc = useQueryClient()
  const [editing, setEditing] = React.useState<BreakGlassPolicy | null>(null)
  const [creating, setCreating] = React.useState(false)
  const query = useQuery({
    queryKey: ["break-glass", "policies"],
    queryFn: breakGlassService.policies,
  })
  const policies = query.data?.policies ?? []
  const del = useMutation({
    mutationFn: (id: number) => breakGlassService.deletePolicy(id),
    onSuccess: () => {
      toast.success("已删除策略")
      qc.invalidateQueries({ queryKey: ["break-glass", "policies"] })
    },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> 新建策略
        </Button>
      </div>
      {query.isLoading ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Spinner className="mr-2 h-4 w-4" /> 加载中…
        </div>
      ) : policies.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="还没有应急访问策略" description="新建一条策略来决定哪些资产可被破玻璃、以及对应的管控要求。" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {policies.map((p) => (
            <div key={p.id} className="rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    {!p.enabled && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">已停用</span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{p.description || "—"}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                    编辑
                  </Button>
                  <ConfirmDeleteIconButton
                    onConfirm={() => del.mutate(p.id)}
                    title="删除策略"
                    description={`确定删除应急访问策略「${p.name}」吗？`}
                  />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
                <Pill>{BG_SCOPE_LABELS[p.scope_type]}</Pill>
                <Pill>最长 {Math.round(p.max_duration_sec / 60)} 分钟</Pill>
                {p.require_incident_ref && <Pill>需工单号</Pill>}
                {p.require_dual_auth && <Pill>双人授权</Pill>}
                {p.allow_fail_open ? (
                  <Pill tone="bg-orange-500/12 text-orange-700 dark:text-orange-300">允许 fail-open</Pill>
                ) : (
                  <Pill>仅审批激活</Pill>
                )}
                {p.require_post_use_review && <Pill>强制复核</Pill>}
              </div>
            </div>
          ))}
        </div>
      )}

      <PolicyEditor
        open={creating || !!editing}
        policy={editing}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        onSaved={() => {
          setCreating(false)
          setEditing(null)
          qc.invalidateQueries({ queryKey: ["break-glass", "policies"] })
        }}
      />
    </div>
  )
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span className={cn("rounded-full bg-muted px-2 py-0.5 text-muted-foreground", tone)}>{children}</span>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function PolicyEditor({
  open,
  policy,
  onClose,
  onSaved,
}: {
  open: boolean
  policy: BreakGlassPolicy | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [enabled, setEnabled] = React.useState(true)
  const [scopeType, setScopeType] = React.useState<"all" | "tag" | "node">("all")
  const [scopeId, setScopeId] = React.useState("")
  const [maxMin, setMaxMin] = React.useState("30")
  const [requireIncident, setRequireIncident] = React.useState(true)
  const [requireDual, setRequireDual] = React.useState(false)
  const [allowFailOpen, setAllowFailOpen] = React.useState(false)
  const [requireReview, setRequireReview] = React.useState(true)

  React.useEffect(() => {
    if (!open) return
    setName(policy?.name ?? "")
    setDescription(policy?.description ?? "")
    setEnabled(policy?.enabled ?? true)
    setScopeType(policy?.scope_type ?? "all")
    setScopeId(policy?.scope_id != null ? String(policy.scope_id) : "")
    setMaxMin(policy ? String(Math.round(policy.max_duration_sec / 60)) : "30")
    setRequireIncident(policy?.require_incident_ref ?? true)
    setRequireDual(policy?.require_dual_auth ?? false)
    setAllowFailOpen(policy?.allow_fail_open ?? false)
    setRequireReview(policy?.require_post_use_review ?? true)
  }, [open, policy])

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim(),
        enabled,
        scope_type: scopeType,
        scope_id: scopeType === "all" || !scopeId ? null : Number(scopeId),
        max_duration_sec: Math.max(60, Math.round(Number(maxMin) || 30) * 60),
        require_incident_ref: requireIncident,
        require_dual_auth: requireDual,
        allow_fail_open: allowFailOpen,
        require_post_use_review: requireReview,
      }
      return policy
        ? breakGlassService.updatePolicy(policy.id, body)
        : breakGlassService.createPolicy(body)
    },
    onSuccess: () => {
      toast.success(policy ? "策略已保存" : "策略已创建")
      onSaved()
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{policy ? "编辑应急访问策略" : "新建应急访问策略"}</DialogTitle>
          <DialogDescription>策略决定哪些资产可被破玻璃，以及对应的管控要求。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="bgp-name">名称</Label>
            <Input id="bgp-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bgp-desc">说明</Label>
            <Textarea id="bgp-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>适用范围</Label>
              <Select value={scopeType} onValueChange={(v) => setScopeType(v as "all" | "tag" | "node")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部资产</SelectItem>
                  <SelectItem value="tag">指定标签</SelectItem>
                  <SelectItem value="node">指定资产</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bgp-scope">
                {scopeType === "node" ? "资产 ID" : scopeType === "tag" ? "标签 ID" : "—"}
              </Label>
              <Input
                id="bgp-scope"
                type="number"
                value={scopeId}
                disabled={scopeType === "all"}
                onChange={(e) => setScopeId(e.target.value)}
                placeholder={scopeType === "all" ? "全部" : "输入 ID"}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bgp-dur">最长时长（分钟）</Label>
            <Input id="bgp-dur" type="number" min={1} value={maxMin} onChange={(e) => setMaxMin(e.target.value)} />
          </div>
          <div className="divide-y rounded-lg border px-3">
            <ToggleRow label="启用策略" checked={enabled} onChange={setEnabled} />
            <ToggleRow
              label="强制工单 / 事件号"
              hint="发起时必须填写关联工单"
              checked={requireIncident}
              onChange={setRequireIncident}
            />
            <ToggleRow
              label="双人授权"
              hint="即使允许 fail-open，也需第二人加速批准"
              checked={requireDual}
              onChange={setRequireDual}
            />
            <ToggleRow
              label="允许自助破玻璃 (fail-open)"
              hint="允许无需事前审批立即开通；仍受全局开关约束"
              checked={allowFailOpen}
              onChange={setAllowFailOpen}
            />
            <ToggleRow
              label="强制事后复核"
              hint="结束后须他人复核签字才闭环"
              checked={requireReview}
              onChange={setRequireReview}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending && <Spinner className="mr-2 h-4 w-4" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
