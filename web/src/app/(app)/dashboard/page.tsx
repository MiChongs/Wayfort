"use client"

// Role-aware dashboard. The backend /dashboard endpoint returns a system-wide
// payload for admin/superadmin and a personal one for everyone else; this page
// renders the matching layout. Every chart goes through the shadcn
// ChartContainer (recharts) so theming + tooltips stay consistent.

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"
import {
  Activity,
  CheckCircle,
  Heart,
  KeyRound,
  LayoutGrid,
  Network,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { dashboardService } from "@/lib/api/services"
import type { DashboardSummary, DashKV, DashSession } from "@/lib/api/types"

const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

const KIND_LABELS: Record<string, string> = {
  interactive: "交互终端",
  sftp: "文件传输",
  graphical: "图形桌面",
  tcp_forward: "端口转发",
  anonymous: "匿名",
  unknown: "其他",
}
const STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  closed: "已结束",
  terminated: "被中断",
  errored: "错误",
  unknown: "其他",
}

export default function DashboardPage() {
  const q = useQuery({ queryKey: ["dashboard"], queryFn: dashboardService.summary })
  const data = q.data

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="display-title text-3xl">总览</h1>
          <p className="text-sm text-muted-foreground">
            {data?.scope === "system" ? "全平台运行态势与会话活动。" : "你的资产、会话与待办一览。"}
          </p>
        </div>
        {data && (
          <Badge variant={data.scope === "system" ? "coral" : "soft"} className="rounded-full">
            {data.tier === "superadmin" ? "超级管理员视图" : data.tier === "admin" ? "管理员视图" : "个人视图"}
          </Badge>
        )}
      </div>

      {q.isLoading || !data ? (
        <DashboardSkeleton />
      ) : data.scope === "system" ? (
        <SystemDashboard data={data} />
      ) : (
        <PersonalDashboard data={data} />
      )}
    </div>
  )
}

// ---------------- system (admin / superadmin) ----------------

function SystemDashboard({ data }: { data: DashboardSummary }) {
  const s = data.stats
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Users} label="用户" value={s.users} tone="plain" />
        <StatCard
          icon={Server}
          label="节点"
          value={s.nodes}
          sub={s.nodes_disabled ? `${s.nodes_disabled} 个已停用` : "全部启用"}
          tone="plain"
        />
        <StatCard icon={Activity} label="活跃会话" value={s.sessions_active} sub={`累计 ${s.sessions_total}`} tone="coral" />
        <StatCard icon={CheckCircle} label="待审批" value={s.approvals_pending} tone={s.approvals_pending > 0 ? "amber" : "plain"} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={KeyRound} label="凭据" value={s.credentials} compact />
        <StatCard icon={Network} label="代理" value={s.proxies} compact />
        <StatCard icon={ShieldCheck} label="今日审计事件" value={s.audit_today} compact />
        <StatCard icon={Server} label="停用节点" value={s.nodes_disabled} compact />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <TrendCard className="lg:col-span-2" title="会话趋势" subtitle="近 14 天" data={data.sessions_daily} />
        <DonutCard title="会话类型" data={data.sessions_by_kind} labels={KIND_LABELS} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <RankCard title="最活跃节点" data={data.top_nodes ?? []} />
        <DonutCard title="会话状态" data={data.sessions_by_status ?? []} labels={STATUS_LABELS} />
        <RecentCard title="近期会话" rows={data.recent_sessions} />
      </div>
    </div>
  )
}

// ---------------- personal (user) ----------------

function PersonalDashboard({ data }: { data: DashboardSummary }) {
  const s = data.stats
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Server} label="可见节点" value={s.visible_nodes} tone="plain" />
        <StatCard icon={Heart} label="收藏" value={s.favorites} tone="plain" />
        <StatCard icon={Activity} label="近 7 天会话" value={s.sessions_7d} tone="coral" />
        <StatCard icon={CheckCircle} label="我的待审批" value={s.approvals_pending} tone={s.approvals_pending > 0 ? "amber" : "plain"} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <TrendCard className="lg:col-span-2" title="我的会话趋势" subtitle="近 14 天" data={data.sessions_daily} />
        <DonutCard title="我的会话类型" data={data.sessions_by_kind} labels={KIND_LABELS} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <RecentCard className="lg:col-span-2" title="我的近期会话" rows={data.recent_sessions} />
        <QuickLinks />
      </div>
    </div>
  )
}

// ---------------- pieces ----------------

type Tone = "plain" | "coral" | "amber"

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "plain",
  compact,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: number
  sub?: string
  tone?: Tone
  compact?: boolean
}) {
  const iconWrap =
    tone === "coral"
      ? "bg-primary/12 text-primary"
      : tone === "amber"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-accent text-muted-foreground"
  return (
    <Card className={cn("gap-0 p-4", compact && "p-3")}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={cn("flex items-center justify-center rounded-md", compact ? "h-6 w-6" : "h-7 w-7", iconWrap)}>
          <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </span>
      </div>
      <div className={cn("mt-1 font-semibold tabular-nums tracking-tight", compact ? "text-xl" : "text-2xl")}>
        {(value ?? 0).toLocaleString()}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </Card>
  )
}

function CardShell({
  title,
  subtitle,
  className,
  children,
}: {
  title: string
  subtitle?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn("gap-0 p-4", className)}>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        {subtitle && <span className="text-[11px] text-muted-foreground">{subtitle}</span>}
      </div>
      {children}
    </Card>
  )
}

function TrendCard({
  title,
  subtitle,
  data,
  className,
}: {
  title: string
  subtitle?: string
  data: { date: string; count: number }[]
  className?: string
}) {
  const config: ChartConfig = { count: { label: "会话", color: "var(--chart-1)" } }
  const total = data.reduce((a, b) => a + b.count, 0)
  return (
    <CardShell title={title} subtitle={subtitle} className={className}>
      {total === 0 ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
          <AreaChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="fill-count" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-count)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-count)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area type="monotone" dataKey="count" stroke="var(--color-count)" strokeWidth={2} fill="url(#fill-count)" />
          </AreaChart>
        </ChartContainer>
      )}
    </CardShell>
  )
}

function DonutCard({ title, data, labels }: { title: string; data: DashKV[]; labels: Record<string, string> }) {
  const config: ChartConfig = {}
  data.forEach((d, i) => {
    config[d.name] = { label: labels[d.name] ?? d.name, color: PALETTE[i % PALETTE.length] }
  })
  const total = data.reduce((a, b) => a + b.value, 0)
  return (
    <CardShell title={title}>
      {total === 0 ? (
        <EmptyChart />
      ) : (
        <>
          <ChartContainer config={config} className="mx-auto aspect-square h-[180px]">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="name" hideLabel />} />
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} strokeWidth={2} paddingAngle={2}>
                {data.map((d) => (
                  <Cell key={d.name} fill={`var(--color-${d.name})`} stroke="var(--background)" />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <div className="mt-2 space-y-1">
            {data.slice(0, 5).map((d) => (
              <div key={d.name} className="flex items-center gap-2 text-xs">
                <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: `var(--color-${d.name})` }} />
                <span className="truncate text-muted-foreground">{labels[d.name] ?? d.name}</span>
                <span className="ml-auto font-medium tabular-nums">{d.value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </CardShell>
  )
}

function RankCard({ title, data }: { title: string; data: DashKV[] }) {
  const config: ChartConfig = { value: { label: "会话数", color: "var(--chart-1)" } }
  return (
    <CardShell title={title}>
      {data.length === 0 ? (
        <EmptyChart />
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
          <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12 }}>
            <XAxis type="number" hide allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="name"
              tickLine={false}
              axisLine={false}
              width={96}
              tickFormatter={(v: string) => (v.length > 10 ? v.slice(0, 10) + "…" : v)}
            />
            <ChartTooltip content={<ChartTooltipContent />} cursor={false} />
            <Bar dataKey="value" fill="var(--color-value)" radius={[0, 5, 5, 0]} barSize={16} />
          </BarChart>
        </ChartContainer>
      )}
    </CardShell>
  )
}

function RecentCard({ title, rows, className }: { title: string; rows: DashSession[]; className?: string }) {
  return (
    <CardShell title={title} className={className}>
      {rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">暂无会话记录</div>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent/50">
              <StatusDot status={r.status} />
              <span className="truncate font-medium">{r.node_name || "—"}</span>
              <span className="truncate text-xs text-muted-foreground">{r.username}</span>
              <Badge variant="outline" className="ml-auto shrink-0 rounded-full font-normal">
                {KIND_LABELS[r.kind] ?? r.kind}
              </Badge>
              <span className="shrink-0 text-[11px] text-muted-foreground">{relTime(r.started_at)}</span>
            </div>
          ))}
        </div>
      )}
    </CardShell>
  )
}

function QuickLinks() {
  const links = [
    { href: "/nodes", label: "节点", icon: Server },
    { href: "/workspace", label: "工作台", icon: LayoutGrid },
    { href: "/sessions", label: "会话", icon: Activity },
    { href: "/ai", label: "AI 助手", icon: Sparkles },
  ]
  return (
    <CardShell title="快捷入口">
      <div className="grid grid-cols-2 gap-2">
        {links.map((l) => {
          const Icon = l.icon
          return (
            <Link
              key={l.href}
              href={l.href}
              className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm transition-colors hover:bg-accent"
            >
              <Icon className="h-4 w-4 text-primary" />
              {l.label}
            </Link>
          )
        })}
      </div>
    </CardShell>
  )
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "active"
      ? "bg-emerald-500"
      : status === "errored"
        ? "bg-destructive"
        : status === "terminated"
          ? "bg-amber-500"
          : "bg-muted-foreground/40"
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} />
}

function EmptyChart() {
  return <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">暂无数据</div>
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Skeleton className="h-[280px] rounded-xl lg:col-span-2" />
        <Skeleton className="h-[280px] rounded-xl" />
      </div>
    </div>
  )
}

function relTime(iso?: string): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ""
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 60) return "刚刚"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return `${Math.floor(day / 30)} 个月前`
}
