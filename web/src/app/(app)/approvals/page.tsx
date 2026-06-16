"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import {
  CalendarCheck,
  Inbox,
  KeyRound,
  LifeBuoy,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EmptyState } from "@/components/common/empty-state"
import { approvalService } from "@/lib/api/services"
import { useAccess } from "@/lib/hooks/use-access"
import { relTime, fullTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  BIZ_ICONS,
  BIZ_LABELS,
  bizLabel,
  riskMeta,
  STATUS_META,
  statusMeta,
  stageModeLabel,
} from "@/lib/approvals/meta"
import { CreateRequestDialog } from "@/components/approvals/create-request-dialog"
import { QuickDecide, BulkDecideBar } from "@/components/approvals/decision"
import { GrantCard } from "@/components/approvals/grant-card"
import { EmergencyAccessDialog } from "@/components/break-glass/emergency-access-dialog"
import type { ApprovalInboxItem, ApprovalRequest } from "@/lib/api/types"

type View = "inbox" | "mine" | "grants"

export default function ApprovalsPage() {
  const access = useAccess()
  const [view, setView] = React.useState<View>("inbox")
  const [bgOpen, setBgOpen] = React.useState(false)

  const overview = useQuery({
    queryKey: ["approval", "overview"],
    queryFn: () => approvalService.overview(),
    refetchInterval: 20_000,
  })
  const ov = overview.data

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">访问治理</p>
          <h1 className="display-title text-3xl">审批中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            在这里处理待你审批的请求、跟进自己发起的申请、管理手中的访问授权。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {access.isAdmin && (
            <Button asChild variant="outline" className="gap-1.5">
              <Link href="/admin/approvals">
                <Settings2 className="h-4 w-4" /> 治理台
              </Link>
            </Button>
          )}
          <Button variant="outline" className="gap-1.5" onClick={() => setBgOpen(true)}>
            <LifeBuoy className="h-4 w-4 text-orange-500" /> 应急访问
          </Button>
          <CreateRequestDialog />
        </div>
      </header>

      <EmergencyAccessDialog open={bgOpen} onOpenChange={setBgOpen} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={Inbox}
          label="待我处理"
          value={ov?.pending_for_me}
          active={view === "inbox"}
          onClick={() => setView("inbox")}
          accent
        />
        <StatCard
          icon={Send}
          label="我发起的进行中"
          value={ov?.my_open_requests}
          active={view === "mine"}
          onClick={() => setView("mine")}
        />
        <StatCard
          icon={KeyRound}
          label="我的有效授权"
          value={ov?.active_grants}
          active={view === "grants"}
          onClick={() => setView("grants")}
        />
        <StatCard icon={CalendarCheck} label="今日已决策" value={ov?.decided_today} muted />
      </div>

      {view === "inbox" && <InboxView />}
      {view === "mine" && <MineView isAdmin={access.isAdmin} />}
      {view === "grants" && <GrantsView />}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  active,
  muted,
  accent,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: number
  active?: boolean
  muted?: boolean
  accent?: boolean
  onClick?: () => void
}) {
  const interactive = !!onClick
  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-card p-3.5 text-left transition-colors",
        interactive && "hover:border-primary/40 hover:bg-accent/40",
        active && "border-primary bg-primary/5 ring-1 ring-primary/20",
        !interactive && "cursor-default",
      )}
    >
      <span
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
          active || accent ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className={cn("block text-2xl font-semibold tabular-nums leading-none", muted && "text-muted-foreground")}>
          {value ?? "—"}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </button>
  )
}

// ---- shared pills ----

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", className)}>
      {children}
    </span>
  )
}

// ---- inbox (待我审批) ----

function InboxView() {
  const q = useQuery({
    queryKey: ["approval", "inbox"],
    queryFn: () => approvalService.inbox(200),
    refetchInterval: 15_000,
  })
  const [search, setSearch] = React.useState("")
  const [selected, setSelected] = React.useState<Set<number>>(new Set())

  const items = q.data?.items ?? []
  const filtered = React.useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return items
    return items.filter((it) => {
      const r = it.request
      return (
        (r.title || "").toLowerCase().includes(s) ||
        (r.requester_name || "").toLowerCase().includes(s) ||
        (r.reason || "").toLowerCase().includes(s) ||
        bizLabel(r.business_type).includes(s) ||
        `${r.resource_type ?? ""}${r.resource_id ?? ""}`.toLowerCase().includes(s)
      )
    })
  }, [items, search])

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allChecked = filtered.length > 0 && filtered.every((it) => selected.has(it.task.id))
  const toggleAll = () =>
    setSelected((prev) => {
      if (filtered.every((it) => prev.has(it.task.id))) {
        const next = new Set(prev)
        filtered.forEach((it) => next.delete(it.task.id))
        return next
      }
      const next = new Set(prev)
      filtered.forEach((it) => next.add(it.task.id))
      return next
    })

  const reload = () => {
    q.refetch()
    setSelected(new Set())
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索申请人、资源、事由…"
            className="pl-8"
          />
        </div>
        {filtered.length > 0 && (
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <Checkbox checked={allChecked} onCheckedChange={toggleAll} /> 全选
          </label>
        )}
        <Button variant="ghost" size="icon" onClick={reload} title="刷新">
          <RefreshCw className={cn("h-4 w-4", q.isFetching && "animate-spin")} />
        </Button>
      </div>

      {q.isLoading ? (
        <ListSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={items.length === 0 ? "没有待你处理的审批" : "没有匹配的结果"}
          description={items.length === 0 ? "需要你决策的请求会出现在这里。" : "换个关键词试试。"}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((it) => (
            <InboxCard
              key={it.task.id}
              item={it}
              checked={selected.has(it.task.id)}
              onToggle={() => toggle(it.task.id)}
              onDone={reload}
            />
          ))}
        </div>
      )}

      <BulkDecideBar taskIds={[...selected]} onClear={() => setSelected(new Set())} onDone={reload} />
    </div>
  )
}

function InboxCard({
  item,
  checked,
  onToggle,
  onDone,
}: {
  item: ApprovalInboxItem
  checked: boolean
  onToggle: () => void
  onDone: () => void
}) {
  const { task, request: r } = item
  const Icon = BIZ_ICONS[r.business_type] ?? ShieldCheck
  const risk = riskMeta(r.risk_level)
  const overdueSoon = task.expires_at && Date.parse(task.expires_at) - Date.now() < 60 * 60 * 1000
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border bg-card p-3.5 transition-colors hover:border-primary/30",
        checked && "border-primary/50 bg-primary/5",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-1" />
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <Link href={`/approvals/${task.request_id}`} className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{r.title || `${bizLabel(r.business_type)}申请`}</span>
          <Pill className={risk.badge}>
            <risk.icon className="h-3 w-3" /> {risk.label}
          </Pill>
          {r.total_stages > 1 && (
            <Pill className="bg-muted text-muted-foreground">
              第 {task.stage + 1}/{r.total_stages} 级 · {stageModeLabel(task.stage_mode, task.quorum_n)}
            </Pill>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          <span className="text-foreground/80">{r.requester_name}</span> 申请{bizLabel(r.business_type)}
          {r.reason ? ` · ${r.reason}` : " · 未填写事由"}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          收到于 {relTime(task.created_at)}
          {task.expires_at && (
            <span className={cn("ml-1", overdueSoon && "text-amber-600 dark:text-amber-400")}>
              · {relTime(task.expires_at)}超时
            </span>
          )}
        </div>
      </Link>
      <div className="shrink-0 pt-0.5">
        <QuickDecide task={task} onDone={onDone} />
      </div>
    </div>
  )
}

// ---- mine (我的申请) ----

function MineView({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = React.useState<string>("")
  const [biz, setBiz] = React.useState<string>("")
  const [scopeAll, setScopeAll] = React.useState(false)

  const q = useQuery({
    queryKey: ["approval", "list", status, biz, scopeAll],
    queryFn: () =>
      approvalService.list({
        mine: !scopeAll,
        status: status || undefined,
        business_type: biz || undefined,
        limit: 100,
      }),
    refetchInterval: 20_000,
  })
  const items = q.data?.items ?? []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.entries(STATUS_META).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={biz || "all"} onValueChange={(v) => setBiz(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="业务类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部业务</SelectItem>
            {Object.entries(BIZ_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isAdmin && (
          <label className="ml-auto flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <Checkbox checked={scopeAll} onCheckedChange={(v) => setScopeAll(!!v)} /> 查看全部用户
          </label>
        )}
      </div>

      {q.isLoading ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Send}
          title="还没有申请"
          description="点右上角「发起申请」开始，或在工作台连接受控资产时按提示申请。"
        />
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <RequestCard key={r.id} req={r} showRequester={scopeAll} />
          ))}
        </div>
      )}
    </div>
  )
}

function RequestCard({ req, showRequester }: { req: ApprovalRequest; showRequester?: boolean }) {
  const Icon = BIZ_ICONS[req.business_type] ?? ShieldCheck
  const sm = statusMeta(req.status)
  const risk = riskMeta(req.risk_level)
  const pending = req.status === "pending"
  return (
    <Link
      href={`/approvals/${req.id}`}
      className="flex items-start gap-3 rounded-xl border bg-card p-3.5 transition-colors hover:border-primary/30"
    >
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{req.title || `${bizLabel(req.business_type)}申请`}</span>
          <Pill className={risk.badge}>
            <risk.icon className="h-3 w-3" /> {risk.label}
          </Pill>
          <span className="text-xs text-muted-foreground">{bizLabel(req.business_type)}</span>
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {showRequester && <span className="text-foreground/80">{req.requester_name} · </span>}
          {req.reason || "未填写事由"}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          提交于 {relTime(req.created_at)}
          {pending && req.total_stages > 1 && ` · 进度 ${Math.min(req.current_stage + 1, req.total_stages)}/${req.total_stages}`}
          {req.effective_window_end && ` · 有效至 ${fullTime(req.effective_window_end)}`}
        </div>
      </div>
      <Pill className={cn("mt-0.5 shrink-0", sm.badge)}>
        <sm.icon className="h-3 w-3" /> {sm.label}
      </Pill>
    </Link>
  )
}

// ---- grants (我的授权) ----

function GrantsView() {
  const [showAll, setShowAll] = React.useState(false)
  const q = useQuery({
    queryKey: ["approval", "my-grants", showAll],
    queryFn: () => approvalService.myGrants(showAll ? "active,expired,revoked,used_up" : "active"),
    refetchInterval: 30_000,
  })
  const items = q.data?.items ?? []
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">通过审批后发放给你的访问授权，到期自动失效。</p>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <Checkbox checked={showAll} onCheckedChange={(v) => setShowAll(!!v)} /> 含历史
        </label>
      </div>
      {q.isLoading ? (
        <ListSkeleton />
      ) : items.length === 0 ? (
        <EmptyState icon={KeyRound} title="暂无有效授权" description="审批通过后，限时访问授权会显示在这里。" />
      ) : (
        <div className="space-y-2">
          {items.map((g) => (
            <GrantCard key={g.id} grant={g} mode="self" onChanged={() => q.refetch()} />
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
        <div key={i} className="h-[78px] animate-pulse rounded-xl border bg-muted/40" />
      ))}
    </div>
  )
}
