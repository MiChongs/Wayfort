"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, Cell, Label, Pie, PieChart, XAxis, YAxis } from "recharts"
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ScrollText,
  Users,
} from "lucide-react"
import type { AuditStats } from "@/lib/api/types"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Segmented } from "@/components/common/segmented"
import {
  AUDIT_CATEGORIES,
  categoryMeta,
  type AuditCategory,
} from "@/lib/session-meta"
import { cn } from "@/lib/utils"

// Donut slice color per category — the sanctioned data-viz palette (chart-1..5)
// plus a warm neutral for the sixth lane. Used by the composition donut + legend.
const CATEGORY_COLOR: Record<AuditCategory, string> = {
  command: "var(--chart-1)",
  file: "var(--chart-2)",
  session: "var(--chart-3)",
  ops: "var(--chart-4)",
  auth: "var(--chart-5)",
  oss: "var(--muted-foreground)",
}

export interface AuditOverviewProps {
  stats?: AuditStats
  loading?: boolean
  onlyAbnormal: boolean
  activeCategory: string
  onPickCategory: (cat: string) => void
  onToggleAbnormal: () => void
  onResetToTotal: () => void
  onPickUser: (name: string) => void
  onPickNode: (name: string) => void
  onPickIp: (ip: string) => void
}

export function AuditOverview(props: AuditOverviewProps) {
  const { stats } = props
  const [collapsed, setCollapsed] = React.useState(false)

  // Restore the collapse preference; default expanded on desktop, collapsed on
  // narrow screens so the event stream keeps room.
  React.useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("audit.overview.collapsed") : null
    if (saved != null) setCollapsed(saved === "1")
    else if (typeof window !== "undefined") setCollapsed(window.innerWidth < 768)
  }, [])
  const toggle = () => {
    setCollapsed((c) => {
      const next = !c
      try { window.localStorage.setItem("audit.overview.collapsed", next ? "1" : "0") } catch { /* */ }
      return next
    })
  }

  return (
    <section className="shrink-0 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          值班概览
        </h2>
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {collapsed ? "展开" : "收起"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>

      {/* KPIs are always visible; the charts collapse. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          icon={ScrollText}
          label="总事件"
          value={stats?.total}
          onClick={props.onResetToTotal}
          active={!props.activeCategory && !props.onlyAbnormal}
        />
        <Kpi
          icon={Activity}
          label="今日新增"
          value={stats?.today}
        />
        <Kpi
          icon={AlertTriangle}
          label="失败 · 异常"
          value={stats?.abnormal}
          tone="danger"
          onClick={props.onToggleAbnormal}
          active={props.onlyAbnormal}
        />
        <Kpi
          icon={Users}
          label="活跃用户"
          value={stats?.active_users}
        />
      </div>

      {!collapsed && (
        <div className="space-y-3">
          <div className="grid gap-3 lg:grid-cols-3">
            <TrendCard stats={stats} className="lg:col-span-2" />
            <CompositionCard
              stats={stats}
              activeCategory={props.activeCategory}
              onPick={props.onPickCategory}
            />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Leaderboard stats={stats} onPickUser={props.onPickUser} onPickNode={props.onPickNode} onPickIp={props.onPickIp} />
            <HeatmapCard stats={stats} />
          </div>
        </div>
      )}
    </section>
  )
}

// ----- KPI -----

function Kpi({
  icon: Icon, label, value, tone = "default", active, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: number
  tone?: "default" | "danger"
  active?: boolean
  onClick?: () => void
}) {
  const interactive = !!onClick
  const danger = tone === "danger" && (value ?? 0) > 0
  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-card p-3.5 text-left transition-colors",
        interactive ? "hover:border-primary/40 hover:bg-accent/40" : "cursor-default",
        danger && "border-destructive/40 bg-destructive/[0.05]",
        active && "border-primary bg-primary/5 ring-1 ring-primary/20",
      )}
    >
      <span className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
        danger ? "bg-destructive/12 text-destructive" : active ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
      )}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-semibold tabular-nums leading-tight">
          {value?.toLocaleString() ?? "—"}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </button>
  )
}

// ----- Trend -----

// renderAbnormalDot draws a small destructive dot (with a soft halo) on the
// trend curve only for days that carried abnormal events — keeping warm red to
// "dots only" per DESIGN.md. Other days return an empty group.
function renderAbnormalDot(props: {
  cx?: number
  cy?: number
  index?: number
  payload?: { abnormal?: number }
}): React.ReactElement {
  const { cx, cy, index, payload } = props
  if (cx == null || cy == null || !payload?.abnormal) {
    return <g key={`ab-${index}`} />
  }
  return (
    <g key={`ab-${index}`}>
      <circle cx={cx} cy={cy} r={6} fill="var(--destructive)" fillOpacity={0.16} />
      <circle cx={cx} cy={cy} r={2.75} fill="var(--destructive)" stroke="var(--card)" strokeWidth={1.25} />
    </g>
  )
}

function TrendCard({ stats, className }: { stats?: AuditStats; className?: string }) {
  const data = stats?.trend ?? []
  const total = data.reduce((a, b) => a + b.count, 0)
  const totalAb = data.reduce((a, b) => a + b.abnormal, 0)
  const config: ChartConfig = {
    count: { label: "事件", color: "var(--chart-1)" },
    abnormal: { label: "异常", color: "var(--destructive)" },
  }
  return (
    <div className={cn("flex flex-col rounded-xl border bg-card p-3.5", className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">近 14 天活动趋势</span>
          <span className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px] bg-primary" />事件量</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-destructive" />异常</span>
          </span>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {total.toLocaleString()} 次 · 异常 {totalAb.toLocaleString()}
        </span>
      </div>
      {total === 0 ? (
        <div className="flex min-h-[240px] flex-1 items-center justify-center text-xs text-muted-foreground">
          这段时间还没有审计事件
        </div>
      ) : (
        // Coral gradient area is the hero (event volume); abnormal days are
        // flagged with small destructive dots-with-halo right on the curve —
        // keeping the warm semantic red to "small dots only" per DESIGN.md. A
        // second, invisible area surfaces the abnormal count in the tooltip.
        <ChartContainer config={config} className="aspect-auto h-[240px] w-full flex-1">
          <AreaChart data={data} margin={{ left: 0, right: 6, top: 14, bottom: 0 }}>
            <defs>
              <linearGradient id="fill-audit" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-count)" stopOpacity={0.4} />
                <stop offset="55%" stopColor="var(--color-count)" stopOpacity={0.12} />
                <stop offset="100%" stopColor="var(--color-count)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.7} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis hide allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {/* Invisible — only here so the tooltip lists the day's abnormal count. */}
            <Area dataKey="abnormal" stroke="transparent" fill="transparent" dot={false} activeDot={false} />
            <Area
              type="monotone"
              dataKey="count"
              stroke="var(--color-count)"
              strokeWidth={2.25}
              fill="url(#fill-audit)"
              dot={renderAbnormalDot}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  )
}

// ----- Category composition -----

function CompositionCard({
  stats, activeCategory, onPick,
}: {
  stats?: AuditStats
  activeCategory: string
  onPick: (cat: string) => void
}) {
  const byCat = stats?.by_category ?? []
  const map = new Map(byCat.map((c) => [c.key, c.count]))
  const rows = AUDIT_CATEGORIES.map((cat) => ({
    cat,
    label: categoryMeta(cat).label,
    icon: categoryMeta(cat).icon,
    count: map.get(cat) ?? 0,
    fill: CATEGORY_COLOR[cat],
  }))
  const total = rows.reduce((a, b) => a + b.count, 0)
  const pieData = rows.filter((r) => r.count > 0)
  const config = Object.fromEntries(
    rows.map((r) => [r.cat, { label: r.label, color: r.fill }]),
  ) as ChartConfig

  return (
    <div className="flex flex-col rounded-xl border bg-card p-3.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium">类别构成</span>
        <span className="text-xs tabular-nums text-muted-foreground">{total.toLocaleString()} 次</span>
      </div>

      {total === 0 ? (
        <div className="flex min-h-[200px] flex-1 items-center justify-center text-xs text-muted-foreground">
          暂无审计事件
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center gap-2">
          <ChartContainer config={config} className="mx-auto aspect-square h-[150px]">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="cat" hideLabel />} />
              <Pie
                data={pieData}
                dataKey="count"
                nameKey="cat"
                innerRadius={46}
                outerRadius={68}
                paddingAngle={2}
                strokeWidth={2}
                stroke="var(--card)"
              >
                {pieData.map((r) => (
                  <Cell key={r.cat} fill={r.fill} className="outline-none" />
                ))}
                <Label
                  content={({ viewBox }) => {
                    if (viewBox && "cx" in viewBox && viewBox.cx != null && viewBox.cy != null) {
                      return (
                        <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                          <tspan x={viewBox.cx} y={viewBox.cy - 4} className="fill-foreground text-lg font-semibold tabular-nums">
                            {total >= 10000 ? `${(total / 1000).toFixed(1)}k` : total.toLocaleString()}
                          </tspan>
                          <tspan x={viewBox.cx} y={viewBox.cy + 14} className="fill-muted-foreground text-[10px]">
                            总事件
                          </tspan>
                        </text>
                      )
                    }
                    return null
                  }}
                />
              </Pie>
            </PieChart>
          </ChartContainer>

          {/* Legend — color · icon · label · count · percent, click to filter. */}
          <div className="grid w-full grid-cols-1 gap-0.5">
            {rows.map((r) => {
              const Icon = r.icon
              const pct = total > 0 ? (r.count / total) * 100 : 0
              const pctLabel = pct === 0 ? "0%" : pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`
              const active = activeCategory === r.cat
              return (
                <button
                  key={r.cat}
                  type="button"
                  onClick={() => onPick(active ? "" : r.cat)}
                  className={cn(
                    "group flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/50",
                    active && "bg-accent",
                  )}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: r.fill }} />
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-xs">{r.label}</span>
                  <span className="shrink-0 text-xs tabular-nums">{r.count.toLocaleString()}</span>
                  <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{pctLabel}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ----- Leaderboard -----

function Leaderboard({
  stats, onPickUser, onPickNode, onPickIp,
}: {
  stats?: AuditStats
  onPickUser: (v: string) => void
  onPickNode: (v: string) => void
  onPickIp: (v: string) => void
}) {
  const [tab, setTab] = React.useState("users")
  const rows =
    tab === "users" ? stats?.top_users :
    tab === "nodes" ? stats?.top_nodes :
    stats?.top_ips
  const pick = tab === "users" ? onPickUser : tab === "nodes" ? onPickNode : onPickIp
  const max = Math.max(1, ...(rows ?? []).map((r) => r.count))
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">活跃排行</span>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { v: "users", label: "用户" },
            { v: "nodes", label: "资产" },
            { v: "ips", label: "来源 IP" },
          ]}
        />
      </div>
      {!rows || rows.length === 0 ? (
        <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">暂无数据</div>
      ) : (
        <div className="space-y-1">
          {rows.map((r, i) => (
            <button
              key={r.key + i}
              type="button"
              onClick={() => pick(r.key)}
              className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/50"
            >
              <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="w-24 shrink-0 truncate text-xs font-medium group-hover:text-primary" title={r.key}>
                {r.key || "—"}
              </span>
              <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <span className="absolute inset-y-0 left-0 rounded-full bg-primary/70" style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{r.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ----- Heatmap (read-only insight) -----

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]
const HEAT_GRID = "repeat(24, minmax(0, 1fr))"
const HEAT_STEPS = [
  "bg-muted/40",
  "bg-primary/15",
  "bg-primary/30",
  "bg-primary/50",
  "bg-primary/70",
  "bg-primary/90",
]

function HeatmapCard({ stats }: { stats?: AuditStats }) {
  const heat = stats?.heatmap
  const { max, total } = React.useMemo(() => {
    let m = 0
    let t = 0
    for (const row of heat ?? []) for (const v of row) { if (v > m) m = v; t += v }
    return { max: m, total: t }
  }, [heat])

  const step = (v: number) => {
    if (max === 0 || v === 0) return HEAT_STEPS[0]
    const idx = Math.min(HEAT_STEPS.length - 1, 1 + Math.floor((v / max) * (HEAT_STEPS.length - 2)))
    return HEAT_STEPS[idx]
  }

  return (
    <div className="flex flex-col rounded-xl border bg-card p-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-medium">活动热力图</span>
        <span className="text-[11px] text-muted-foreground">小时 × 星期</span>
      </div>
      {!heat || max === 0 ? (
        <div className="flex min-h-[160px] flex-1 items-center justify-center text-xs text-muted-foreground">暂无数据</div>
      ) : (
        <div className="flex flex-1 flex-col justify-center gap-2">
          <div className="flex flex-col gap-1">
            {heat.map((row, d) => (
              <div key={d} className="flex items-center gap-1.5">
                <span className="w-3.5 shrink-0 text-center text-[10px] leading-none text-muted-foreground">{WEEKDAYS[d]}</span>
                <div className="grid flex-1 gap-1" style={{ gridTemplateColumns: HEAT_GRID }}>
                  {row.map((v, h) => (
                    <span
                      key={h}
                      title={`周${WEEKDAYS[d]} ${String(h).padStart(2, "0")}:00 · ${v} 次`}
                      className={cn(
                        "aspect-square rounded-[3px] ring-primary/0 transition-all duration-150 hover:ring-2 hover:ring-primary/60",
                        step(v),
                      )}
                    />
                  ))}
                </div>
              </div>
            ))}
            {/* Hour ruler — labelled every 6 hours, aligned to the columns. */}
            <div className="flex items-center gap-1.5">
              <span className="w-3.5 shrink-0" />
              <div className="grid flex-1 gap-1" style={{ gridTemplateColumns: HEAT_GRID }}>
                {Array.from({ length: 24 }).map((_, h) => (
                  <span key={h} className="text-center text-[9px] leading-none text-muted-foreground/70 tabular-nums">
                    {h % 6 === 0 ? String(h).padStart(2, "0") : ""}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-between pt-0.5">
            <span className="text-[10px] text-muted-foreground">峰值 {max.toLocaleString()} 次/格 · 共 {total.toLocaleString()}</span>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">少</span>
              {HEAT_STEPS.map((s, i) => (
                <span key={i} className={cn("h-3 w-3 rounded-[3px]", s)} />
              ))}
              <span className="text-[10px] text-muted-foreground">多</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
