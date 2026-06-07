"use client"

import { ArrowDown, ArrowUp, Clock, Gauge } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DesktopStatus, SessionStats } from "./desktop-types"
import { formatClock, type LinkQuality } from "./desktop-connection"
import { LatencySparkline } from "./desktop-signal"

type Props = {
  status: DesktopStatus
  remoteWidth: number
  remoteHeight: number
  pointerX: number
  pointerY: number
  stats: SessionStats
  keyboardLayout: string
  // Live extras from the connection model.
  sessionMs?: number | null
  latencyHistory?: number[]
  quality?: LinkQuality
  // Optional — when provided, the status bar shows a trailing "性能" button
  // that opens the perf panel. Falsy hides it cleanly.
  onOpenPerfPanel?: () => void
}

const STATUS_UI: Record<DesktopStatus, { label: string; dot: string }> = {
  "loading-script": { label: "加载中", dot: "bg-[#d4a017] dark:bg-[#e3b84e]" },
  connecting: { label: "连接中", dot: "bg-[#d4a017] dark:bg-[#e3b84e]" },
  handshake: { label: "握手中", dot: "bg-[#d4a017] dark:bg-[#e3b84e]" },
  connected: { label: "已连接", dot: "bg-[#5db872]" },
  reconnecting: { label: "重连中", dot: "bg-[#d4a017] dark:bg-[#e3b84e]" },
  closed: { label: "已断开", dot: "bg-muted-foreground" },
  error: { label: "连接失败", dot: "bg-destructive" },
}

const TONE_TEXT: Record<LinkQuality["tone"], string> = {
  good: "text-[#4c9b62] dark:text-[#5db872]",
  fair: "text-[#c08a2e] dark:text-[#e3b84e]",
  poor: "text-destructive",
  muted: "text-muted-foreground",
}

export function DesktopStatusBar({
  status,
  remoteWidth,
  remoteHeight,
  pointerX,
  pointerY,
  stats,
  keyboardLayout,
  sessionMs,
  latencyHistory,
  quality,
  onOpenPerfPanel,
}: Props) {
  const reduce = useReducedMotion()
  const ui = STATUS_UI[status]
  const transient =
    status === "connecting" || status === "handshake" || status === "reconnecting" || status === "loading-script"
  const tone = quality?.tone ?? "muted"
  const latencyText = TONE_TEXT[tone]

  return (
    <footer
      className={cn(
        "flex h-7 shrink-0 select-none items-center gap-2.5 px-2.5",
        "border-t border-border/50 bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40",
        "text-[11px] text-muted-foreground",
      )}
      aria-label="桌面状态栏"
    >
      {/* status */}
      <span className="inline-flex items-center gap-1.5">
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", ui.dot)} />
          {transient && !reduce && (
            <span className={cn("absolute inset-0 animate-ping rounded-full", ui.dot)} />
          )}
        </span>
        <span className="text-foreground/70">{ui.label}</span>
      </span>

      {/* session timer — only once connected */}
      {sessionMs != null && (
        <>
          <Sep />
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock className="h-3 w-3 text-muted-foreground/60" />
            <span className="font-mono">{formatClock(sessionMs)}</span>
          </span>
        </>
      )}

      <Sep />
      <span className="font-mono tabular-nums">
        {remoteWidth || "—"}×{remoteHeight || "—"}
      </span>

      <Sep className="hidden xl:inline-block" />
      <span className="hidden font-mono tabular-nums xl:inline">
        {pointerX}:{pointerY}
      </span>

      <Sep className="hidden sm:inline-block" />
      <span className="hidden items-center gap-1.5 font-mono tabular-nums sm:inline-flex">
        <ArrowDown className="h-3 w-3 text-[#5db872]/80" />
        {formatBytes(stats.bytesIn)}
        <ArrowUp className="ml-1 h-3 w-3 text-muted-foreground/70" />
        {formatBytes(stats.bytesOut)}
      </span>

      {/* latency + sparkline */}
      <Sep />
      <span className={cn("inline-flex items-center gap-1.5 font-mono tabular-nums", latencyText)}>
        {stats.latencyMs == null ? "— ms" : `${stats.latencyMs} ms`}
        {latencyHistory && latencyHistory.length >= 2 && (
          <span className={latencyText}>
            <LatencySparkline points={latencyHistory} tone={tone} />
          </span>
        )}
      </span>

      {stats.fps != null && (
        <>
          <Sep className="hidden md:inline-block" />
          <span className="hidden font-mono tabular-nums md:inline">{stats.fps.toFixed(0)} fps</span>
        </>
      )}
      {stats.transport && (
        <>
          <Sep className="hidden md:inline-block" />
          <span className="hidden text-foreground/65 md:inline">{stats.transport}</span>
        </>
      )}

      <span className="ml-auto inline-flex items-center gap-2.5">
        <span className="font-mono uppercase text-muted-foreground/70">{keyboardLayout}</span>
        {onOpenPerfPanel && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onOpenPerfPanel}
            aria-label="打开性能监视面板"
            title="性能监视  (Ctrl+Shift+P)"
            className="-mr-1 h-5 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Gauge className="h-3 w-3" />
            <span>性能</span>
          </Button>
        )}
      </span>
    </footer>
  )
}

function Sep({ className }: { className?: string }) {
  return <span className={cn("inline-block h-3 w-px bg-border", className)} aria-hidden />
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
