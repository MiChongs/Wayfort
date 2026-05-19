"use client"

// DesktopPerfPanel — slide-in performance dashboard for an active
// desktop session. Lives in a shadcn <Sheet> on the right edge so it
// overlays the canvas without resizing it (no jank when toggled).
//
// What it shows:
//   • 6 KPI cards — FPS / Latency / Decode / Paint / ↓ KB/s / ↑ KB/s
//   • 3 Recharts area charts — FPS, latency, bandwidth (in+out lines)
//   • Cumulative dropped-frames + JS heap (when measurable)
//   • Export-as-JSON + Reset buffer buttons
//
// All metrics come from the parent's live `stats` object (driven by the
// render worker + heartbeat). The panel itself owns no measurement
// state — `use-perf-metrics` does the ring-buffer bookkeeping.

import * as React from "react"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts"
import { Activity, Download, RotateCw } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { SessionStats } from "./desktop-types"
import { usePerfMetrics, type PerfSample } from "@/lib/desktop/use-perf-metrics"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Stable identifier — changing it clears the perf history. */
  sessionKey: string | number
  /** Live SessionStats from DesktopDisplay; the panel samples this. */
  stats: SessionStats
  /** Decorative — rendered in the sheet header. */
  nodeName?: string
}

// Recharts reads each `stroke={...}` directly so we don't need
// ChartContainer's CSS-variable plumbing here. The `var(--chart-N)`
// values are defined at `:root` in globals.css (added by `npx shadcn
// add chart`) so they resolve in both light + dark mode.

export function DesktopPerfPanel({ open, onOpenChange, sessionKey, stats, nodeName }: Props) {
  // Only sample while the panel is mounted. Closing it still keeps
  // the buffer (Sheet stays mounted by shadcn's design) so reopening
  // is instant; if the consumer truly unmounts the panel the hook's
  // session-key effect cleans up.
  const { samples, summary, reset } = usePerfMetrics(sessionKey, stats, open)

  function handleExport() {
    const blob = new Blob([JSON.stringify({ sessionKey, samples }, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `desktop-perf-${sessionKey}-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  const current = summary.current
  const heapMb = readJsHeapMb()

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[460px] sm:max-w-[460px] flex flex-col gap-0 p-0">
        <SheetHeader className="px-5 pt-5 pb-3 border-b">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <SheetTitle className="flex items-center gap-2 text-base">
                <Activity className="w-4 h-4 text-primary" />
                性能监视
              </SheetTitle>
              <SheetDescription className="text-xs truncate">
                {nodeName ? `${nodeName} · ` : ""}Client-side metrics（服务端 telemetry 待 Devolutions Gateway 暴露）
              </SheetDescription>
            </div>
            <Badge variant="secondary" className="text-[10px] uppercase shrink-0">
              {samples.length} samples
            </Badge>
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {/* KPI grid */}
          <div className="grid grid-cols-3 gap-2">
            <KpiCard label="FPS" value={current?.fps ?? null} tone={fpsTone(current?.fps)} />
            <KpiCard
              label="延迟"
              value={current?.latencyMs ?? null}
              suffix="ms"
              tone={latencyTone(current?.latencyMs)}
            />
            <KpiCard
              label="解码"
              value={current?.avgDecodeMs ?? null}
              suffix="ms"
              precision={1}
            />
            <KpiCard label="绘制" value={current?.avgPaintMs ?? null} suffix="ms" precision={1} />
            <KpiCard
              label="↓ 流量"
              value={current ? bytesPerSecForCard(current.bytesInPerSec) : null}
              suffix="/s"
            />
            <KpiCard
              label="↑ 流量"
              value={current ? bytesPerSecForCard(current.bytesOutPerSec) : null}
              suffix="/s"
            />
          </div>

          {/* Mini meta strip */}
          <div className="flex items-center justify-between text-[11px] text-muted-foreground border rounded-md px-3 py-2 bg-muted/30">
            <div>
              <span className="text-foreground/80 font-mono">{summary.avgFps ?? "—"}</span> 平均FPS
              <span className="mx-2 opacity-30">|</span>
              p95 <span className="text-foreground/80 font-mono">{summary.p95LatencyMs ?? "—"}</span>ms
            </div>
            <div>
              丢帧 <span className="text-foreground/80 font-mono">{current?.droppedFramesTotal ?? 0}</span>
              {heapMb != null && (
                <>
                  <span className="mx-2 opacity-30">|</span>
                  堆 <span className="text-foreground/80 font-mono">{heapMb.toFixed(1)}</span>MB
                </>
              )}
            </div>
          </div>

          {/* Charts */}
          <PerfChart
            title="FPS"
            samples={samples}
            dataKey="fps"
            color="var(--chart-1)"
            unit="fps"
            domain={[0, 60]}
          />
          <PerfChart
            title="延迟 (ms)"
            samples={samples}
            dataKey="latencyMs"
            color="var(--chart-2)"
            unit="ms"
          />
          <PerfChart
            title="带宽 (B/s)"
            samples={samples}
            dataKey="bytesInPerSec"
            secondaryKey="bytesOutPerSec"
            color="var(--chart-3)"
            secondaryColor="var(--chart-4)"
            unit="B/s"
          />
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 px-5 py-3 border-t bg-muted/20">
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5">
            <Download className="w-3.5 h-3.5" />
            导出 JSON
          </Button>
          <Button variant="ghost" size="sm" onClick={reset} className="gap-1.5">
            <RotateCw className="w-3.5 h-3.5" />
            重置数据
          </Button>
        </div>

      </SheetContent>
    </Sheet>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  suffix,
  precision,
  tone,
}: {
  label: string
  value: number | string | null
  suffix?: string
  precision?: number
  tone?: "good" | "warn" | "bad"
}) {
  const display =
    value == null
      ? "—"
      : typeof value === "string"
        ? value
        : precision != null
          ? value.toFixed(precision)
          : String(Math.round(value))
  const toneClass =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "bad"
          ? "text-red-600 dark:text-red-400"
          : "text-foreground"
  return (
    <div className="rounded-md border px-3 py-2 bg-card flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-mono tabular-nums leading-tight", toneClass)}>
        {display}
        {suffix && value != null && (
          <span className="text-[10px] text-muted-foreground ml-0.5">{suffix}</span>
        )}
      </div>
    </div>
  )
}

interface PerfChartProps {
  title: string
  samples: PerfSample[]
  dataKey: keyof PerfSample
  secondaryKey?: keyof PerfSample
  color: string
  secondaryColor?: string
  unit: string
  domain?: [number, number]
}

function PerfChart({
  title,
  samples,
  dataKey,
  secondaryKey,
  color,
  secondaryColor,
  unit,
  domain,
}: PerfChartProps) {
  // recharts coerces null values to gaps — exactly what we want when
  // latency / decode aren't measurable, so the chart line breaks where
  // the metric is unavailable rather than dropping to zero.
  return (
    <div className="rounded-md border bg-card overflow-hidden">
      <div className="px-3 py-1.5 flex items-center justify-between border-b">
        <div className="text-xs font-medium">{title}</div>
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {samples.length > 0 ? `${samples.length}s` : "等待数据…"}
          {unit ? <span className="ml-1 opacity-70">· {unit}</span> : null}
        </div>
      </div>
      <div className="h-[120px] px-1 py-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={samples} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id={`fill-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.5} />
                <stop offset="95%" stopColor={color} stopOpacity={0.05} />
              </linearGradient>
              {secondaryKey && secondaryColor && (
                <linearGradient id={`fill-${secondaryKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={secondaryColor} stopOpacity={0.5} />
                  <stop offset="95%" stopColor={secondaryColor} stopOpacity={0.05} />
                </linearGradient>
              )}
            </defs>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" tick={false} axisLine={false} height={0} />
            <YAxis
              tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
              width={28}
              domain={domain ?? ["auto", "auto"]}
              tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#fill-${dataKey})`}
              isAnimationActive={false}
              connectNulls={false}
            />
            {secondaryKey && secondaryColor && (
              <Area
                type="monotone"
                dataKey={secondaryKey}
                stroke={secondaryColor}
                strokeWidth={1.5}
                fill={`url(#fill-${secondaryKey})`}
                isAnimationActive={false}
                connectNulls={false}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function fpsTone(fps: number | null | undefined): "good" | "warn" | "bad" | undefined {
  if (fps == null) return undefined
  if (fps >= 30) return "good"
  if (fps >= 15) return "warn"
  return "bad"
}
function latencyTone(ms: number | null | undefined): "good" | "warn" | "bad" | undefined {
  if (ms == null) return undefined
  if (ms <= 80) return "good"
  if (ms <= 200) return "warn"
  return "bad"
}

// Chrome / Edge expose `performance.memory.usedJSHeapSize`; Safari /
// Firefox don't. Return null when missing so the meta strip hides
// that column instead of showing 0.
function readJsHeapMb(): number | null {
  if (typeof performance === "undefined") return null
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  if (!mem || typeof mem.usedJSHeapSize !== "number") return null
  return mem.usedJSHeapSize / (1024 * 1024)
}

// Bytes/sec preformatted for a small card slot — KB if it exceeds 1KB,
// MB if >1MB. Returns a string so KpiCard's "precision" path is skipped.
function bytesPerSecForCard(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
