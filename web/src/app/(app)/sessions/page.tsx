"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { toast } from "@/components/ui/sonner"
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"
import {
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clapperboard,
  History,
  Layers,
  Power,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Radio,
} from "lucide-react"
import { sessionService } from "@/lib/api/services"
import type { Session } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from "@/components/ui/chart"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { useAccess } from "@/lib/hooks/use-access"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { kindMeta, statusMeta, fmtDuration, KIND_META } from "@/lib/session-meta"
import { cn } from "@/lib/utils"

const PAGE_SIZE = 25

const RANGES: { key: string; label: string }[] = [
  { key: "all", label: "全部时间" },
  { key: "today", label: "今天" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
]

function rangeFrom(key: string): string | undefined {
  const now = new Date()
  if (key === "today") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return d.toISOString()
  }
  if (key === "7d") return new Date(now.getTime() - 7 * 86400_000).toISOString()
  if (key === "30d") return new Date(now.getTime() - 30 * 86400_000).toISOString()
  return undefined
}

export default function SessionsPage() {
  const access = useAccess()
  const canTerminate = access.isSuperadmin || access.permissions.includes("session:terminate")
  const canObserve = access.isSuperadmin || access.permissions.includes("session:observe")

  const [tab, setTab] = React.useState<"all" | "live">("all")
  const [status, setStatus] = React.useState("")
  const [kind, setKind] = React.useState("")
  const [q, setQ] = React.useState("")
  const [dq, setDq] = React.useState("")
  const [range, setRange] = React.useState("all")
  const [page, setPage] = React.useState(0)

  // Debounce the search box so each keystroke doesn't hit the server.
  React.useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  const effectiveStatus = tab === "live" ? "active" : status
  const from = React.useMemo(() => rangeFrom(range), [range])

  const reset = () => setPage(0)
  // Any filter change returns to the first page.
  React.useEffect(reset, [tab, status, kind, dq, range])

  const list = useQuery({
    queryKey: ["sessions", tab, effectiveStatus, kind, dq, from, page],
    queryFn: () =>
      sessionService.list({
        status: effectiveStatus || undefined,
        kind: kind || undefined,
        q: dq || undefined,
        from,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    refetchInterval: tab === "live" ? 5000 : false,
  })

  const stats = useQuery({
    queryKey: ["sessions", "stats"],
    queryFn: () => sessionService.stats(14),
    refetchInterval: 30_000,
  })

  const rows = list.data?.sessions ?? []
  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  async function terminate(s: Session) {
    const km = kindMeta(s.kind)
    const ok = await confirmDialog({
      title: "强制下线该会话？",
      description: (
        <>
          将立即断开 <b>{s.username}</b> 在 <b>{s.node_name || "目标"}</b> 上的{km.label}。
          对方终端会被切断，此操作记入审计。
        </>
      ),
      confirmLabel: "强制下线",
      destructive: true,
    })
    if (!ok) return
    try {
      await sessionService.terminate(s.id)
      toast.success("会话已下线")
      list.refetch()
      stats.refetch()
    } catch (e) {
      toast.error((e as { message?: string }).message || "下线失败")
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">会话审计</p>
          <h1 className="display-title text-3xl">会话</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            每一次接入都在这里留痕——谁、从哪、连了什么、做了什么，都能回看与追责。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Link href="/sessions/timeline">
            <Button variant="outline" size="sm">
              <Layers className="h-4 w-4" /> 时间线
            </Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={() => { list.refetch(); stats.refetch() }}>
            <RefreshCw className={cn("h-4 w-4", list.isFetching && "animate-spin")} /> 刷新
          </Button>
        </div>
      </header>

      {/* Overview strip + trend */}
      <div className="grid gap-3 lg:grid-cols-[1fr_1.1fr]">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
          <StatCard
            icon={Radio}
            label="进行中"
            value={stats.data?.active}
            accent
            pulse={(stats.data?.active ?? 0) > 0}
            active={tab === "live"}
            onClick={() => setTab("live")}
          />
          <StatCard
            icon={History}
            label="今日会话"
            value={stats.data?.today}
            active={tab === "all" && range === "today"}
            onClick={() => { setTab("all"); setRange("today"); setStatus("") }}
          />
          <StatCard icon={Clapperboard} label="有录像" value={stats.data?.recorded} />
          <StatCard
            icon={CircleDot}
            label="累计会话"
            value={stats.data?.total}
            onClick={() => { setTab("all"); setRange("all"); setStatus(""); setKind(""); setQ("") }}
          />
        </div>
        <TrendCard data={stats.data?.trend ?? []} />
      </div>

      {/* Segmented tabs */}
      <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-1 w-fit">
        <SegBtn active={tab === "all"} onClick={() => setTab("all")}>全部会话</SegBtn>
        <SegBtn active={tab === "live"} onClick={() => setTab("live")}>
          <span className="relative flex h-2 w-2">
            {(stats.data?.active ?? 0) > 0 && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
            )}
            <span className={cn("relative inline-flex h-2 w-2 rounded-full", (stats.data?.active ?? 0) > 0 ? "bg-emerald-500" : "bg-muted-foreground/40")} />
          </span>
          在线会话
          {(stats.data?.active ?? 0) > 0 && <span className="text-xs tabular-nums opacity-70">{stats.data?.active}</span>}
        </SegBtn>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72 max-w-full">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索资产 / 用户 / 来源 IP / 会话 ID"
            className="pl-8"
          />
        </div>
        <Select value={kind || "all"} onValueChange={(v) => setKind(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36"><SelectValue placeholder="类型" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {Object.entries(KIND_META).map(([k, m]) => (
              <SelectItem key={k} value={k}>{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {tab === "all" && (
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
            <SelectTrigger className="w-32"><SelectValue placeholder="状态" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="active">进行中</SelectItem>
              <SelectItem value="closed">已结束</SelectItem>
              <SelectItem value="terminated">已下线</SelectItem>
              <SelectItem value="errored">异常中断</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          共 {total.toLocaleString()} 条
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">资产 / 会话</th>
              <th className="px-3 py-2.5 text-left font-medium">用户</th>
              <th className="hidden px-3 py-2.5 text-left font-medium md:table-cell">来源</th>
              <th className="px-3 py-2.5 text-left font-medium">时长</th>
              <th className="hidden px-3 py-2.5 text-left font-medium lg:table-cell">流量</th>
              <th className="px-3 py-2.5 text-left font-medium">开始</th>
              <th className="px-3 py-2.5 text-left font-medium">状态</th>
              <th className="px-4 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <SessionRow key={s.id} s={s} canTerminate={canTerminate} canObserve={canObserve} onTerminate={terminate} />
            ))}
            {list.isLoading &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-t">
                  <td colSpan={8} className="px-4 py-3">
                    <div className="h-8 animate-pulse rounded-md bg-muted/50" />
                  </td>
                </tr>
              ))}
            {!list.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-2">
                  <EmptyState
                    icon={tab === "live" ? Radio : History}
                    title={tab === "live" ? "当前没有进行中的会话" : "没有匹配的会话"}
                    description={
                      tab === "live"
                        ? "有人接入资产时会实时出现在这里。"
                        : q || status || kind || range !== "all"
                          ? "换个关键词或放宽筛选条件试试。"
                          : "还没有任何接入记录。"
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <span className="text-xs text-muted-foreground">
            第 {page + 1} / {pages} 页
          </span>
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            <ChevronLeft className="h-4 w-4" /> 上一页
          </Button>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            下一页 <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

function StatCard({
  icon: Icon, label, value, active, accent, pulse, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: number
  active?: boolean
  accent?: boolean
  pulse?: boolean
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
        !interactive && "cursor-default",
        active && "border-primary bg-primary/5 ring-1 ring-primary/20",
      )}
    >
      <span
        className={cn(
          "relative grid h-9 w-9 shrink-0 place-items-center rounded-lg",
          active || accent ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
        {pulse && (
          <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-semibold tabular-nums">{value ?? "—"}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </button>
  )
}

function TrendCard({ data }: { data: { date: string; count: number }[] }) {
  const config: ChartConfig = { count: { label: "会话", color: "var(--chart-1)" } }
  const total = data.reduce((a, b) => a + b.count, 0)
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium">近 14 天接入趋势</span>
        <span className="text-xs text-muted-foreground tabular-nums">{total} 次</span>
      </div>
      {total === 0 ? (
        <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
          这段时间还没有会话
        </div>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[120px] w-full">
          <AreaChart data={data} margin={{ left: 0, right: 6, top: 6, bottom: 0 }}>
            <defs>
              <linearGradient id="fill-sess" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-count)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-count)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              minTickGap={28}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis hide allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area type="monotone" dataKey="count" stroke="var(--color-count)" strokeWidth={2} fill="url(#fill-sess)" />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  )
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function SessionRow({
  s, canTerminate, canObserve, onTerminate,
}: {
  s: Session
  canTerminate: boolean
  canObserve: boolean
  onTerminate: (s: Session) => void
}) {
  const km = kindMeta(s.kind)
  const sm = statusMeta(s.status)
  const Icon = km.icon
  const isActive = s.status === "active"
  const hasRec = !!s.recording_path
  const canMonitor =
    isActive && canObserve && (s.kind === "interactive" || s.kind === "anonymous" || s.kind === "graphical")
  return (
    <tr className="border-t transition-colors hover:bg-accent/30">
      <td className="px-4 py-2.5">
        <Link href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]} className="group flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium group-hover:underline">{s.node_name || "匿名目标"}</span>
            <span className="block font-mono text-[11px] text-muted-foreground">{s.id.slice(0, 12)}…</span>
          </span>
        </Link>
      </td>
      <td className="px-3 py-2.5 text-sm">{s.username}</td>
      <td className="hidden px-3 py-2.5 font-mono text-xs text-muted-foreground md:table-cell">{s.client_ip || "—"}</td>
      <td className="px-3 py-2.5 text-sm tabular-nums">
        {isActive ? (
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            {fmtDuration(s.started_at)}
          </span>
        ) : (
          <span className="text-muted-foreground">{fmtDuration(s.started_at, s.ended_at)}</span>
        )}
      </td>
      <td className="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell tabular-nums">
        ↑{fmtBytes(s.bytes_in)} ↓{fmtBytes(s.bytes_out)}
      </td>
      <td className="px-3 py-2.5 text-xs">
        <div className="text-foreground">{fullTime(s.started_at)}</div>
        <div className="text-muted-foreground">{relTime(s.started_at)}</div>
      </td>
      <td className="px-3 py-2.5">
        <Badge variant={sm.tone}>{sm.label}</Badge>
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center justify-end gap-1">
          {hasRec && (
            <Link
              href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-primary/10"
            >
              <Clapperboard className="h-3.5 w-3.5" /> 回放
            </Link>
          )}
          {canMonitor && (
            <Link
              href={`/sessions/${s.id}/monitor` as Parameters<typeof Link>[0]["href"]}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-primary/10"
            >
              <Radio className="h-3.5 w-3.5" /> 监看
            </Link>
          )}
          {isActive && canTerminate && (
            <button
              type="button"
              onClick={() => onTerminate(s)}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-destructive hover:bg-destructive/10"
            >
              <Power className="h-3.5 w-3.5" /> 下线
            </button>
          )}
          <Link
            href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}
            className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            详情
          </Link>
        </div>
      </td>
    </tr>
  )
}
