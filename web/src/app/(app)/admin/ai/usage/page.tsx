"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts"
import { Activity, Coins, Cpu, Layers, Zap } from "lucide-react"
import { aiUsageService, type AIUsageBucket } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { cn } from "@/lib/utils"

const DAY_OPTIONS = [7, 30, 90] as const
const MODEL_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export default function AIUsagePage() {
  const [days, setDays] = React.useState<number>(30)
  const [scope, setScope] = React.useState<"me" | "all">("me")

  const q = useQuery({
    queryKey: ["ai", "usage", days, scope],
    queryFn: () => aiUsageService.summary(days, scope),
  })
  const data = q.data
  const canAdmin = !!data?.can_admin

  // Aggregate cost per day for the trend chart (sum across models).
  const trend = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const b of data?.buckets || []) {
      m.set(b.day, (m.get(b.day) || 0) + b.cost_micros)
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, cost]) => ({ day: day.slice(5), cost: cost / 1_000_000 }))
  }, [data])

  // Cost & tokens grouped by model (top 8) — derived from existing buckets, no
  // backend change. Colours cycle the chart token ramp.
  const byModel = React.useMemo(() => {
    const m = new Map<string, { cost: number; tokens: number }>()
    for (const b of data?.buckets || []) {
      const k = b.model || "—"
      const cur = m.get(k) || { cost: 0, tokens: 0 }
      cur.cost += b.cost_micros
      cur.tokens += b.input_tokens + b.output_tokens
      m.set(k, cur)
    }
    return [...m.entries()]
      .map(([model, v]) => ({ model, cost: v.cost / 1_000_000, tokens: v.tokens }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 8)
  }, [data])
  const modelCount = React.useMemo(
    () => new Set((data?.buckets || []).map((b) => b.model).filter(Boolean)).size,
    [data],
  )

  const t = data?.totals
  const cacheRatio =
    t && t.input_tokens + t.cache_read_tokens > 0
      ? Math.round((t.cache_read_tokens / (t.input_tokens + t.cache_read_tokens)) * 100)
      : 0

  const columns: Column<AIUsageBucket & { id?: string }>[] = [
    { header: "日期", cell: (r) => <span className="font-mono text-xs">{r.day}</span> },
    { header: "模型", cell: (r) => <span className="font-mono text-xs">{r.model || "—"}</span> },
    { header: "输入", cell: (r) => <span className="tabular-nums">{fmtTok(r.input_tokens)}</span>, className: "text-right" },
    { header: "输出", cell: (r) => <span className="tabular-nums">{fmtTok(r.output_tokens)}</span>, className: "text-right" },
    {
      header: "缓存命中",
      cell: (r) => <span className="tabular-nums text-success">{r.cache_read_tokens ? fmtTok(r.cache_read_tokens) : "—"}</span>,
      className: "text-right",
    },
    { header: "成本", cell: (r) => <span className="tabular-nums">~{fmtCost(r.cost_micros)}</span>, className: "text-right" },
    { header: "消息", cell: (r) => <span className="tabular-nums text-muted-foreground">{r.messages}</span>, className: "text-right" },
  ]

  const chartConfig: ChartConfig = { cost: { label: "成本 (USD)", color: "var(--chart-1)" } }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display-title text-2xl">AI 用量与成本</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            按公开 list price 估算的累计 token 与成本{scope === "all" ? "（全部用户）" : "（仅你）"}。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canAdmin && (
            <Segmented
              value={scope}
              onChange={(v) => setScope(v as "me" | "all")}
              options={[
                { v: "me", label: "我的" },
                { v: "all", label: "全部用户" },
              ]}
            />
          )}
          <Segmented
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={DAY_OPTIONS.map((d) => ({ v: String(d), label: `${d}天` }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={Coins} label="累计成本" value={t ? `~${fmtCost(t.cost_micros)}` : "—"} />
        <Stat
          icon={Activity}
          label="输入 / 输出 token"
          value={t ? `${fmtTok(t.input_tokens)} / ${fmtTok(t.output_tokens)}` : "—"}
        />
        <Stat
          icon={Zap}
          label="缓存命中"
          value={t ? `${fmtTok(t.cache_read_tokens)} · ${cacheRatio}%` : "—"}
          accent="success"
        />
        <Stat icon={Cpu} label="助手轮次" value={t ? t.messages.toLocaleString() : "—"} />
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="eyebrow mb-3">每日成本趋势</div>
        {trend.length === 0 ? (
          <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
            {q.isLoading ? "加载中…" : "暂无用量数据"}
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[180px] w-full">
            <AreaChart data={trend} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="fill-cost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-cost)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--color-cost)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} className="text-[10px]" />
              <YAxis hide />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="cost" stroke="var(--color-cost)" strokeWidth={2} fill="url(#fill-cost)" />
            </AreaChart>
          </ChartContainer>
        )}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">按模型成本（Top 8）</div>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Layers className="size-3.5" /> {modelCount} 个模型
          </span>
        </div>
        {byModel.length === 0 ? (
          <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
            {q.isLoading ? "加载中…" : "暂无用量数据"}
          </div>
        ) : (
          <ChartContainer
            config={{ cost: { label: "成本 (USD)", color: "var(--chart-1)" } }}
            className="aspect-auto w-full"
            style={{ height: Math.max(120, byModel.length * 34) }}
          >
            <BarChart data={byModel} layout="vertical" margin={{ left: 8, right: 16, top: 0, bottom: 0 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis type="number" tickLine={false} axisLine={false} className="text-[10px]" />
              <YAxis
                type="category"
                dataKey="model"
                width={130}
                tickLine={false}
                axisLine={false}
                className="text-[10px]"
                tickFormatter={(v: string) => (v.length > 18 ? v.slice(0, 17) + "…" : v)}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                {byModel.map((_, i) => (
                  <Cell key={i} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </div>

      <div className="space-y-2">
        <div className="eyebrow">明细（按日 / 模型）</div>
        <DataTable
          columns={columns}
          rows={data?.buckets}
          loading={q.isLoading}
          empty="暂无用量数据"
          virtualize
          rowKey={(r, i) => `${r.day}-${r.model}-${i}`}
        />
      </div>
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  accent?: "success"
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5", accent === "success" ? "text-success" : "text-muted-foreground")} />
        {label}
      </div>
      <div className="mt-1.5 text-lg font-medium tabular-nums">{value}</div>
    </div>
  )
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { v: string; label: string }[]
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return `${n}`
}

function fmtCost(micros: number): string {
  const usd = micros / 1_000_000
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}
