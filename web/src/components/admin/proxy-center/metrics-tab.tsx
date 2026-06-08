"use client"

import * as React from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts"
import { Card, CardContent } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import type { Proxy, ProxyMetricsSnapshot } from "@/lib/api/types"

const BYTE_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${u[i]}`
}

function clock(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour12: false })
}

export function MetricsTab({
  metrics,
  proxies,
}: {
  metrics?: ProxyMetricsSnapshot
  proxies: Proxy[]
}) {
  const nameById = React.useMemo(() => new Map(proxies.map((p) => [p.id, p.name])), [proxies])

  const series = React.useMemo(
    () => (metrics?.series ?? []).map((s) => ({ t: clock(s.ts), dials: s.dials, failures: s.failures, active: s.active_conns })),
    [metrics],
  )

  const byBytes = React.useMemo(() => {
    const list = Object.values(metrics?.proxies ?? {})
      .map((m) => ({ name: nameById.get(m.proxy_id) ?? `#${m.proxy_id}`, bytes: m.bytes_in + m.bytes_out }))
      .filter((x) => x.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8)
    return list
  }, [metrics, nameById])

  if (!metrics) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">指标采集中…</CardContent>
      </Card>
    )
  }

  const dialConfig: ChartConfig = {
    dials: { label: "拨号", color: "var(--chart-1)" },
    failures: { label: "失败", color: "var(--chart-3)" },
  }
  const activeConfig: ChartConfig = { active: { label: "活动连接", color: "var(--chart-2)" } }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Panel title="拨号 vs 失败（累计）">
        {series.length === 0 ? (
          <Empty />
        ) : (
          <ChartContainer config={dialConfig} className="aspect-auto h-[200px] w-full">
            <AreaChart data={series} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="fill-dials" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-dials)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--color-dials)" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="fill-failures" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-failures)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--color-failures)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis dataKey="t" tickLine={false} axisLine={false} tickMargin={8} className="text-[10px]" />
              <YAxis hide />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="dials" stroke="var(--color-dials)" strokeWidth={2} fill="url(#fill-dials)" />
              <Area type="monotone" dataKey="failures" stroke="var(--color-failures)" strokeWidth={2} fill="url(#fill-failures)" />
            </AreaChart>
          </ChartContainer>
        )}
      </Panel>

      <Panel title="活动连接">
        {series.length === 0 ? (
          <Empty />
        ) : (
          <ChartContainer config={activeConfig} className="aspect-auto h-[200px] w-full">
            <AreaChart data={series} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="fill-active" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-active)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--color-active)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis dataKey="t" tickLine={false} axisLine={false} tickMargin={8} className="text-[10px]" />
              <YAxis hide />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="active" stroke="var(--color-active)" strokeWidth={2} fill="url(#fill-active)" />
            </AreaChart>
          </ChartContainer>
        )}
      </Panel>

      <Panel title="流量 Top 8（按代理）" className="xl:col-span-2">
        {byBytes.length === 0 ? (
          <Empty hint="尚无流量。建立一些会话后这里会显示每个代理的字节数。" />
        ) : (
          <ChartContainer
            config={{ bytes: { label: "字节", color: "var(--chart-1)" } }}
            className="aspect-auto w-full"
            style={{ height: Math.max(120, byBytes.length * 34) }}
          >
            <BarChart data={byBytes} layout="vertical" margin={{ left: 8, right: 16, top: 0, bottom: 0 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis type="number" tickLine={false} axisLine={false} className="text-[10px]" tickFormatter={fmtBytes} />
              <YAxis
                type="category"
                dataKey="name"
                width={130}
                tickLine={false}
                axisLine={false}
                className="text-[10px]"
                tickFormatter={(v: string) => (v.length > 18 ? v.slice(0, 17) + "…" : v)}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="bytes" radius={[0, 4, 4, 0]}>
                {byBytes.map((_, i) => (
                  <Cell key={i} fill={BYTE_COLORS[i % BYTE_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </Panel>
    </div>
  )
}

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="rounded-xl border bg-card p-4">
        <div className="eyebrow mb-3">{title}</div>
        {children}
      </div>
    </div>
  )
}

function Empty({ hint }: { hint?: string }) {
  return (
    <div className="flex h-[160px] items-center justify-center text-center text-sm text-muted-foreground">
      {hint ?? "采集中…"}
    </div>
  )
}
