"use client"

import * as React from "react"
import { ListTree, Terminal as TerminalIcon, Upload } from "lucide-react"
import type { AuditEvent } from "@/lib/api/types"
import { auditMeta } from "@/lib/session-meta"
import { fmtBytes, fullTime } from "@/lib/format"
import { EmptyState } from "@/components/common/empty-state"
import { cn } from "@/lib/utils"
import type { ReplayController } from "@/lib/viz/replay-sync"
import { eventOffsetMs, fmtClock } from "@/lib/viz/replay-sync"

type Filter = "all" | "command" | "file" | "lifecycle"

// SyncedTimeline is the per-session audit timeline. When given a ReplayController
// it becomes a synchronised axis: the row matching the current playhead is
// highlighted and auto-scrolled into view, and clicking any row seeks the player
// to that moment. Without a controller (guac download / no recording) it degrades
// to a static, read-only list.
export function SyncedTimeline({
  events,
  loading,
  live,
  sessionStart,
  sessionDurationMs,
  controller,
}: {
  events: AuditEvent[]
  loading?: boolean
  live?: boolean
  sessionStart: string
  sessionDurationMs: number
  controller?: ReplayController | null
}) {
  const [filter, setFilter] = React.useState<Filter>("all")
  const [curMs, setCurMs] = React.useState(0)

  React.useEffect(() => {
    if (!controller) return
    return controller.onTime((ms) => setCurMs(ms))
  }, [controller])

  const rows = React.useMemo(
    () =>
      events.map((e) => ({
        ...e,
        ms: eventOffsetMs(e.created_at, sessionStart, sessionDurationMs),
      })),
    [events, sessionStart, sessionDurationMs],
  )

  const counts = React.useMemo(() => {
    const c = { all: rows.length, command: 0, file: 0, lifecycle: 0 }
    for (const e of rows) c[auditMeta(e.kind).group]++
    return c
  }, [rows])

  const shown = React.useMemo(
    () => (filter === "all" ? rows : rows.filter((e) => auditMeta(e.kind).group === filter)),
    [rows, filter],
  )

  // Active row = the last event at or before the playhead.
  const activeId = React.useMemo(() => {
    if (!controller) return null
    let id: number | null = null
    for (const e of shown) {
      if (e.ms <= curMs) id = e.id
      else break
    }
    return id
  }, [controller, shown, curMs])

  const chips: { key: Filter; label: string; icon?: React.ComponentType<{ className?: string }> }[] = [
    { key: "all", label: "全部" },
    { key: "command", label: "命令", icon: TerminalIcon },
    { key: "file", label: "文件", icon: Upload },
    { key: "lifecycle", label: "事件", icon: ListTree },
  ]

  return (
    <div className="flex h-full flex-col rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <ListTree className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">操作审计</span>
        {controller && <span className="text-xs text-muted-foreground">· 与回放同步</span>}
        {live && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            实时
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {chips.map((c) => {
            const Icon = c.icon
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setFilter(c.key)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                  filter === c.key ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {Icon && <Icon className="h-3 w-3" />}
                {c.label}
                <span className="tabular-nums opacity-70">{counts[c.key]}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {loading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={TerminalIcon}
            title={filter === "command" ? "没有捕获到命令" : "暂无审计记录"}
            description={
              filter === "command"
                ? "图形 / 转发类会话不产生命令；终端命令会在输入回车后逐条记录。"
                : "这次会话没有产生此类操作。"
            }
          />
        ) : (
          <ol className="relative space-y-0.5">
            {shown.map((e) => (
              <TimelineRow
                key={e.id}
                e={e}
                active={e.id === activeId}
                seekable={!!controller}
                onSeek={() => {
                  controller?.seekMs(e.ms)
                  controller?.play()
                }}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function TimelineRow({
  e,
  active,
  seekable,
  onSeek,
}: {
  e: AuditEvent & { ms: number }
  active: boolean
  seekable: boolean
  onSeek: () => void
}) {
  const m = auditMeta(e.kind)
  const Icon = m.icon
  const detail = renderPayload(e)
  const ref = React.useRef<HTMLLIElement | null>(null)
  React.useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" })
  }, [active])
  return (
    <li
      ref={ref}
      onClick={seekable ? onSeek : undefined}
      className={cn(
        "flex items-start gap-3 rounded-md px-2 py-1.5",
        seekable && "cursor-pointer",
        active ? "bg-primary/12 ring-1 ring-primary/30" : "hover:bg-accent/30",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md",
          m.group === "command"
            ? "bg-primary/12 text-primary"
            : m.group === "file"
              ? "bg-sky-500/12 text-sky-600 dark:text-sky-400"
              : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {m.group === "command" ? (
          <code className="block break-all rounded bg-muted/60 px-2 py-1 font-mono text-[13px] text-foreground">
            {e.payload || ""}
          </code>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm">{m.label}</span>
            {detail && <span className="break-all font-mono text-xs text-muted-foreground">{detail}</span>}
          </div>
        )}
      </div>
      <time className="shrink-0 text-xs tabular-nums text-muted-foreground" title={fullTime(e.created_at)}>
        {seekable ? fmtClock(e.ms) : timeOnly(e.created_at)}
      </time>
    </li>
  )
}

function timeOnly(iso?: string): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false })
  } catch {
    return ""
  }
}

// renderPayload pulls the human-meaningful bit out of an audit payload — for
// file/oss events that's the path; everything else shows the raw payload.
function renderPayload(e: AuditEvent): string {
  const p = e.payload || ""
  if (!p) return ""
  if (e.kind.startsWith("file.") || e.kind.startsWith("oss.")) {
    const m = p.match(/bytes=(\d+)/)
    const path = p.replace(/\s*bytes=\d+\s*$/, "")
    if (m) return `${path} · ${fmtBytes(Number(m[1]))}`
    return path
  }
  return p
}
