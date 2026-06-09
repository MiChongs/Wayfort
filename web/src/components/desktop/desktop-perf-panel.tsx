"use client"

// DesktopPerfPanel — the slide-in performance monitor for a live desktop
// session. Redesigned to the warm design system: coral-accented header, metric
// cards with inline sparklines, a render-pipeline strip, a stability strip, and
// two warm-themed trend charts. Tones use the warm semantic tokens
// (success/warning/destructive) — never cool emerald/red.
//
// All metrics come from the parent's live `stats`; `use-perf-metrics` owns the
// ring-buffer bookkeeping. The panel renders, it doesn't measure.

import * as React from "react"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts"
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Download,
  Gauge,
  RotateCw,
  Zap,
} from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { VIZ } from "@/lib/viz/theme"
import type { SessionStats } from "./desktop-types"
import { usePerfMetrics, type PerfSample } from "@/lib/desktop/use-perf-metrics"
import { Sparkline } from "./perf-sparkline"

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

type Tone = "good" | "warn" | "bad"

export function DesktopPerfPanel({ open, onOpenChange, sessionKey, stats, nodeName }: Props) {
  const { samples, summary, reset } = usePerfMetrics(sessionKey, stats, open)

  function handleExport() {
    const blob = new Blob([JSON.stringify({ sessionKey, samples }, null, 2)], { type: "application/json" })
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
      <SheetContent side="right" className="flex w-[460px] flex-col gap-0 p-0 sm:max-w-[460px]">
        {/* ── Header ── */}
        <SheetHeader className="space-y-0 border-b px-5 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Activity className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex items-center gap-2 text-base font-semibold">
                性能监视
                <span className="inline-flex items-center gap-1 text-xs font-normal text-success">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                  </span>
                  实时
                </span>
              </SheetTitle>
              <SheetDescription className="truncate text-xs">
                {nodeName ? `${nodeName} · ` : ""}客户端实时指标 · {samples.length} 个采样
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* ── Hero metric cards with sparklines ── */}
          <div className="grid grid-cols-2 gap-2.5">
            <MetricCard
              icon={Gauge}
              label="帧率"
              value={current?.fps ?? null}
              unit="fps"
              tone={fpsTone(current?.fps)}
              accent={VIZ.coral}
              series={samples.map((s) => s.fps)}
            />
            <MetricCard
              icon={Zap}
              label="延迟"
              value={current?.latencyMs ?? null}
              unit="ms"
              tone={latencyTone(current?.latencyMs)}
              accent={VIZ.teal}
              series={samples.map((s) => s.latencyMs)}
            />
            <MetricCard
              icon={ArrowDownToLine}
              label="下行带宽"
              value={current ? bytesPerSec(current.bytesInPerSec) : null}
              unit="/s"
              accent={VIZ.amber}
              series={samples.map((s) => s.bytesInPerSec)}
            />
            <MetricCard
              icon={ArrowUpFromLine}
              label="上行带宽"
              value={current ? bytesPerSec(current.bytesOutPerSec) : null}
              unit="/s"
              accent={VIZ.green}
              series={samples.map((s) => s.bytesOutPerSec)}
            />
          </div>

          {/* ── Render pipeline ── */}
          <Section title="渲染管线">
            <div className="flex flex-wrap gap-1.5">
              <Pill label="编码" value={codecLabel(stats.codec)} tone={codecTone(stats.codec)} />
              <Pill label="解码器" value={decoderPathLabel(stats.decoderPath)} tone={decoderPathTone(stats.decoderPath)} />
              {stats.renderSurface && (
                <Pill
                  label="渲染面"
                  value={renderSurfaceLabel(stats.renderSurface)}
                  tone={stats.renderSurface === "webgpu" ? "good" : undefined}
                />
              )}
              <Pill label="解码" value={fmtMs(current?.avgDecodeMs)} />
              <Pill label="绘制" value={fmtMs(current?.avgPaintMs)} />
            </div>
          </Section>

          {/* ── Stability ── */}
          <Section title="稳定性">
            <div className="grid grid-cols-4 gap-2">
              <Stat label="平均帧率" value={summary.avgFps != null ? String(summary.avgFps) : "—"} suffix="fps" />
              <Stat label="p95 延迟" value={summary.p95LatencyMs != null ? String(summary.p95LatencyMs) : "—"} suffix="ms" />
              <Stat
                label="丢帧"
                value={String(current?.droppedFramesTotal ?? 0)}
                tone={(current?.droppedFramesTotal ?? 0) > 0 ? "warn" : undefined}
              />
              <Stat label="堆内存" value={heapMb != null ? heapMb.toFixed(0) : "—"} suffix="MB" />
            </div>
          </Section>

          {/* ── Detailed trends ── */}
          <PerfChart title="帧率" subtitle="fps" samples={samples} dataKey="fps" color={VIZ.coral} domain={[0, 60]} />
          <PerfChart
            title="带宽"
            subtitle="↓ 下行 · ↑ 上行"
            samples={samples}
            dataKey="bytesInPerSec"
            secondaryKey="bytesOutPerSec"
            color={VIZ.amber}
            secondaryColor={VIZ.green}
            byteAxis
          />
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center gap-2 border-t bg-muted/20 px-5 py-3">
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            导出 JSON
          </Button>
          <Button variant="ghost" size="sm" onClick={reset} className="gap-1.5">
            <RotateCw className="h-3.5 w-3.5" />
            重置数据
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ─── Building blocks ────────────────────────────────────────────────────────

function toneClass(tone?: Tone): string {
  switch (tone) {
    case "good":
      return "text-success"
    case "warn":
      return "text-warning"
    case "bad":
      return "text-destructive"
    default:
      return "text-foreground"
  }
}

function MetricCard({
  icon: Icon,
  label,
  value,
  unit,
  tone,
  accent,
  series,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number | string | null
  unit?: string
  tone?: Tone
  accent: string
  series: (number | null)[]
}) {
  const display =
    value == null ? "—" : typeof value === "string" ? value : String(Math.round(value))
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={cn("text-2xl font-semibold tabular-nums leading-none", toneClass(tone))}>{display}</span>
        {unit && value != null && <span className="text-xs text-muted-foreground">{unit}</span>}
      </div>
      <div className="mt-2">
        <Sparkline data={series} color={accent} />
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{title}</div>
      {children}
    </div>
  )
}

function Pill({ label, value, tone }: { label: string; value: string | null; tone?: Tone }) {
  if (!value) return null
  const dot =
    tone === "good" ? "bg-success" : tone === "warn" ? "bg-warning" : tone === "bad" ? "bg-destructive" : "bg-muted-foreground/40"
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs">
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </span>
  )
}

function Stat({ label, value, suffix, tone }: { label: string; value: string; suffix?: string; tone?: Tone }) {
  return (
    <div className="rounded-lg border bg-card px-2.5 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-base font-semibold tabular-nums leading-none", toneClass(tone))}>
        {value}
        {suffix && value !== "—" && <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  )
}

interface PerfChartProps {
  title: string
  subtitle?: string
  samples: PerfSample[]
  dataKey: keyof PerfSample
  secondaryKey?: keyof PerfSample
  color: string
  secondaryColor?: string
  domain?: [number, number]
  byteAxis?: boolean
}

function PerfChart({ title, subtitle, samples, dataKey, secondaryKey, color, secondaryColor, domain, byteAxis }: PerfChartProps) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="text-xs font-medium">{title}</div>
        <div className="text-[10px] tabular-nums text-muted-foreground">
          {subtitle ? <span className="opacity-70">{subtitle}</span> : null}
          <span className="ml-1.5">{samples.length > 0 ? `${samples.length}s` : "等待数据…"}</span>
        </div>
      </div>
      <div className="h-[112px] px-1 py-1">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={samples} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id={`pf-${String(dataKey)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.4} />
                <stop offset="95%" stopColor={color} stopOpacity={0.03} />
              </linearGradient>
              {secondaryKey && secondaryColor && (
                <linearGradient id={`pf-${String(secondaryKey)}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={secondaryColor} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={secondaryColor} stopOpacity={0.03} />
                </linearGradient>
              )}
            </defs>
            <CartesianGrid stroke={VIZ.grid} strokeOpacity={0.5} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" tick={false} axisLine={false} height={0} />
            <YAxis
              tick={{ fontSize: 9, fill: VIZ.tick }}
              width={byteAxis ? 38 : 26}
              domain={domain ?? ["auto", "auto"]}
              tickFormatter={byteAxis ? (v: number) => bytesPerSec(v) : (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
            />
            <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={`url(#pf-${String(dataKey)})`} isAnimationActive={false} connectNulls={false} />
            {secondaryKey && secondaryColor && (
              <Area type="monotone" dataKey={secondaryKey} stroke={secondaryColor} strokeWidth={1.5} fill={`url(#pf-${String(secondaryKey)})`} isAnimationActive={false} connectNulls={false} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Metric helpers (tones use warm semantic tokens) ────────────────────────

function fpsTone(fps: number | null | undefined): Tone | undefined {
  if (fps == null) return undefined
  if (fps >= 30) return "good"
  if (fps >= 15) return "warn"
  return "bad"
}
function latencyTone(ms: number | null | undefined): Tone | undefined {
  if (ms == null) return undefined
  if (ms <= 80) return "good"
  if (ms <= 200) return "warn"
  return "bad"
}

function codecLabel(codec: string | null | undefined): string | null {
  if (!codec) return null
  switch (codec) {
    case "h264": return "H.264"
    case "rfx": return "RFX"
    case "jpeg": return "JPEG"
    case "png": return "PNG"
    case "raw_bgra": return "BGRA"
    case "zlib_bgra": return "BGRA·z"
    default: return codec
  }
}
function codecTone(codec: string | null | undefined): Tone | undefined {
  if (!codec) return undefined
  if (codec === "h264") return "good"
  if (codec === "rfx" || codec === "jpeg") return "warn"
  return undefined
}
function decoderPathLabel(path: string | null | undefined): string | null {
  if (!path) return null
  switch (path) {
    case "videodecoder": return "VideoDecoder"
    case "imagedecoder": return "ImageDecoder"
    case "imagebitmap": return "ImageBitmap"
    case "js": return "JS"
    default: return path
  }
}
function decoderPathTone(path: string | null | undefined): Tone | undefined {
  if (!path) return undefined
  if (path === "videodecoder" || path === "imagedecoder") return "good"
  if (path === "imagebitmap") return "warn"
  if (path === "js") return "bad"
  return undefined
}
function renderSurfaceLabel(s: "webgpu" | "canvas2d" | null | undefined): string {
  if (s === "webgpu") return "WebGPU"
  if (s === "canvas2d") return "Canvas2D"
  return "—"
}

function fmtMs(v: number | null | undefined): string | null {
  if (v == null) return null
  return `${v.toFixed(1)} ms`
}

function readJsHeapMb(): number | null {
  if (typeof performance === "undefined") return null
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  if (!mem || typeof mem.usedJSHeapSize !== "number") return null
  return mem.usedJSHeapSize / (1024 * 1024)
}

function bytesPerSec(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
