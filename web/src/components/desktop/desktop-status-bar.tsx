"use client"

import { Activity } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DesktopStatus, SessionStats } from "./desktop-types"

type Props = {
  status: DesktopStatus
  remoteWidth: number
  remoteHeight: number
  pointerX: number
  pointerY: number
  stats: SessionStats
  keyboardLayout: string
  // Optional — when provided, the status bar shows a trailing
  // "性能监视" button (Activity icon) that opens the perf panel.
  // Falsy / undefined hides it cleanly so callers without a panel
  // don't see a dead control.
  onOpenPerfPanel?: () => void
}

const STATUS_TINT: Record<DesktopStatus, string> = {
  "loading-script": "bg-amber-500",
  connecting: "bg-amber-500",
  handshake: "bg-amber-500",
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-500",
  closed: "bg-zinc-500",
  error: "bg-red-500",
}

const STATUS_LABEL: Record<DesktopStatus, string> = {
  "loading-script": "加载中",
  connecting: "连接中",
  handshake: "握手中",
  connected: "已连接",
  reconnecting: "重连中",
  closed: "已断开",
  error: "错误",
}

export function DesktopStatusBar({
  status,
  remoteWidth,
  remoteHeight,
  pointerX,
  pointerY,
  stats,
  keyboardLayout,
  onOpenPerfPanel,
}: Props) {
  // Latency colour: green ≤ 80ms, amber ≤ 200ms, red beyond.
  const latencyClass =
    stats.latencyMs == null
      ? "text-muted-foreground"
      : stats.latencyMs > 500
        ? "text-red-500"
        : stats.latencyMs > 200
          ? "text-amber-500"
          : "text-emerald-500"
  const reducedMotion = useReducedMotion()
  return (
    <footer
      className={cn(
        "h-6 shrink-0 px-2 inline-flex items-center gap-3 select-none",
        "border-t border-border/50",
        "bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40",
        "text-[10px] font-mono text-muted-foreground",
      )}
      aria-label="desktop status"
    >
      <span className="inline-flex items-center gap-1.5">
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 360, damping: 26 }}
          className={cn("inline-block w-1.5 h-1.5 rounded-full", STATUS_TINT[status])}
          aria-hidden
        />
        {!reducedMotion && (status === "connecting" || status === "handshake" || status === "reconnecting" || status === "loading-script") && (
          <span className={cn("absolute -ml-[1.5px] -mt-[1.5px] inline-block h-2 w-2 animate-ping rounded-full opacity-60", STATUS_TINT[status])} aria-hidden />
        )}
        {STATUS_LABEL[status]}
      </span>
      <Pipe />
      <span>
        {remoteWidth || "-"}×{remoteHeight || "-"}
      </span>
      <Pipe />
      <span>
        cursor {pointerX}:{pointerY}
      </span>
      <Pipe />
      <span>
        <ArrowDown /> {formatBytes(stats.bytesIn)}
        <span className="mx-1 text-muted-foreground/50">·</span>
        <ArrowUp /> {formatBytes(stats.bytesOut)}
      </span>
      <Pipe />
      <span className={latencyClass}>
        {stats.latencyMs == null ? "— ms" : `${stats.latencyMs} ms`}
      </span>
      {stats.fps != null && (
        <>
          <Pipe />
          <span>{stats.fps.toFixed(0)} fps</span>
        </>
      )}
      <span className="ml-auto opacity-70 uppercase">{keyboardLayout}</span>
      {onOpenPerfPanel && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onOpenPerfPanel}
          aria-label="打开性能监视面板"
          title="性能监视  (Ctrl+Shift+P)"
          className="-mr-1 h-5 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Activity className="h-3 w-3" />
          <span>性能</span>
        </Button>
      )}
    </footer>
  )
}

function Pipe() {
  return <span className="opacity-30">|</span>
}

function ArrowDown() {
  return <span className="text-emerald-500/80">↓</span>
}

function ArrowUp() {
  return <span className="text-blue-500/80">↑</span>
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
