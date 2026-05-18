"use client"

import { cn } from "@/lib/utils"
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
}

const STATUS_TINT: Record<Status, string> = {
  connecting: "bg-amber-500",
  open: "bg-emerald-500",
  closed: "bg-red-500",
}

const STATUS_LABEL: Record<Status, string> = {
  connecting: "连接中",
  open: "已连接",
  closed: "已断开",
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
}: Props) {
  return (
    <footer
      className={cn(
        "h-6 shrink-0 px-2 inline-flex items-center gap-3 select-none",
        "border-t border-border/50",
        "bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40",
        "text-[10px] font-mono text-muted-foreground",
      )}
      aria-label="terminal status"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full", STATUS_TINT[status])} />
        {STATUS_LABEL[status]}
      </span>
      <Pipe />
      <span>
        {cols}×{rows}
      </span>
      <Pipe />
      <span>
        cursor {cursorY + 1}:{cursorX + 1}
      </span>
      <Pipe />
      <span>
        <ArrowDown /> {formatBytes(bytesIn)}
        <span className="mx-1 text-muted-foreground/50">·</span>
        <ArrowUp /> {formatBytes(bytesOut)}
      </span>
      <Pipe />
      <span>{latencyMs == null ? "— ms" : `${latencyMs} ms`}</span>
      <span className="ml-auto opacity-70">UTF-8</span>
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
