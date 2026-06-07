"use client"

import { ArrowDown, ArrowUp, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatClock, type LinkQuality } from "@/components/desktop/desktop-connection"
import { LatencySparkline } from "@/components/desktop/desktop-signal"
import type { Status } from "./terminal-types"

type Props = {
  status: Status
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  bytesIn: number
  bytesOut: number
  latencyMs: number | null
  sessionMs?: number | null
  latencyHistory?: number[]
  quality?: LinkQuality
}

const STATUS_UI: Record<Status, { label: string; dot: string }> = {
  connecting: { label: "连接中", dot: "bg-[#d4a017] dark:bg-[#e3b84e]" },
  reconnecting: { label: "重连中", dot: "bg-[#d4a017] dark:bg-[#e3b84e]" },
  open: { label: "已连接", dot: "bg-[#5db872]" },
  closed: { label: "已断开", dot: "bg-muted-foreground" },
  error: { label: "连接失败", dot: "bg-destructive" },
}

const TONE_TEXT: Record<LinkQuality["tone"], string> = {
  good: "text-[#4c9b62] dark:text-[#5db872]",
  fair: "text-[#c08a2e] dark:text-[#e3b84e]",
  poor: "text-destructive",
  muted: "text-muted-foreground",
}

export function TerminalStatusBar({
  status,
  cols,
  rows,
  cursorX,
  cursorY,
  bytesIn,
  bytesOut,
  latencyMs,
  sessionMs,
  latencyHistory,
  quality,
}: Props) {
  const ui = STATUS_UI[status]
  const transient = status === "connecting" || status === "reconnecting"
  const tone = quality?.tone ?? "muted"

  return (
    <footer
      className={cn(
        "flex h-7 shrink-0 select-none items-center gap-2.5 px-2.5",
        "border-t border-border/50 bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40",
        "text-[11px] text-muted-foreground",
      )}
      aria-label="终端状态栏"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", ui.dot)} />
          {transient && <span className={cn("absolute inset-0 animate-ping rounded-full", ui.dot)} />}
        </span>
        <span className="text-foreground/70">{ui.label}</span>
      </span>

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
        {cols}×{rows}
      </span>

      <Sep className="hidden xl:inline-block" />
      <span className="hidden font-mono tabular-nums xl:inline">
        {cursorY + 1}:{cursorX + 1}
      </span>

      <Sep className="hidden sm:inline-block" />
      <span className="hidden items-center gap-1.5 font-mono tabular-nums sm:inline-flex">
        <ArrowDown className="h-3 w-3 text-[#5db872]/80" />
        {formatBytes(bytesIn)}
        <ArrowUp className="ml-1 h-3 w-3 text-muted-foreground/70" />
        {formatBytes(bytesOut)}
      </span>

      <Sep />
      <span className={cn("inline-flex items-center gap-1.5 font-mono tabular-nums", TONE_TEXT[tone])}>
        {latencyMs == null ? "— ms" : `${latencyMs} ms`}
        {latencyHistory && latencyHistory.length >= 2 && (
          <span className={TONE_TEXT[tone]}>
            <LatencySparkline points={latencyHistory} tone={tone} />
          </span>
        )}
      </span>

      <span className="ml-auto font-mono text-muted-foreground/70">UTF-8</span>
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
