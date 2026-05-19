"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WorkspaceTab as WorkspaceTabModel } from "./useWorkspaceStore"
import { metaOf } from "./protocolMeta"

type Props = {
  tab: WorkspaceTabModel
  active: boolean
  editingTitle?: boolean
  onActivate: () => void
  onClose: () => void
  onContextMenu: (ev: React.MouseEvent) => void
  onDoubleClick: () => void
  onRenameSubmit: (next: string) => void
  onRenameCancel: () => void
  onDragStart: (ev: React.DragEvent) => void
  onDragOver: (ev: React.DragEvent) => void
  onDrop: (ev: React.DragEvent) => void
  onDragEnd: () => void
  dragOver?: "left" | "right" | null
}

const STATUS_LABEL: Record<WorkspaceTabModel["status"], string> = {
  fresh: "未连接",
  connecting: "连接中",
  connected: "已连接",
  closed: "已关闭",
  error: "连接错误",
}

// WorkspaceTab — shadcn-style browser tab with clear status semantics.
// The outer wrapper owns HTML drag-and-drop + click events (motion's gesture
// types clash with React's DragEvent types). The inner motion.div is purely
// visual: layout animations, enter/exit, and the layoutId-shared active
// accent that slides between tabs.
export const WorkspaceTab = React.forwardRef<HTMLDivElement, Props>(function WorkspaceTab(
  {
    tab,
    active,
    editingTitle,
    onActivate,
    onClose,
    onContextMenu,
    onDoubleClick,
    onRenameSubmit,
    onRenameCancel,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    dragOver,
    ...rest
  },
  ref,
) {
  const meta = metaOf(tab.protocol)
  const Icon = meta.icon
  const reduced = useReducedMotion()
  const [draft, setDraft] = React.useState(tab.title)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!editingTitle) return
    setDraft(tab.title)
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [editingTitle, tab.title])

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      onClick={onActivate}
      onAuxClick={(ev) => {
        if (ev.button === 1) {
          ev.preventDefault()
          onClose()
        }
      }}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      draggable={!editingTitle}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title={`${tab.title}${tab.host ? ` (${tab.host}${tab.port ? ":" + tab.port : ""})` : ""} · ${STATUS_LABEL[tab.status]}`}
      className="contents"
      {...rest}
    >
      <motion.div
        layout={!reduced}
        initial={reduced ? false : { opacity: 0, scale: 0.96, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduced ? undefined : { opacity: 0, scale: 0.92, y: 4 }}
        transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
        className={cn(
          "group/tab relative flex items-center gap-2 h-9 px-3 min-w-[148px] max-w-[232px] shrink-0",
          "border-r border-border/60 text-sm cursor-default select-none",
          "transition-colors duration-150",
          active
            ? "bg-card text-foreground"
            : "bg-muted/20 text-muted-foreground hover:bg-muted/45 hover:text-foreground",
        )}
      >
        {/* Active accent — shared layoutId animates between active tabs. */}
        {active && (
          <motion.span
            layoutId="workspace-tab-active"
            className="absolute inset-x-0 top-0 h-[2px] bg-primary"
            transition={{ type: "spring", stiffness: 480, damping: 38 }}
          />
        )}

        {/* Drag indicators — thin primary line on the drop side. */}
        {dragOver === "left" && (
          <motion.span
            initial={{ opacity: 0, scaleY: 0.6 }}
            animate={{ opacity: 1, scaleY: 1 }}
            className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full"
          />
        )}
        {dragOver === "right" && (
          <motion.span
            initial={{ opacity: 0, scaleY: 0.6 }}
            animate={{ opacity: 1, scaleY: 1 }}
            className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary rounded-full"
          />
        )}

        <Icon
          className={cn(
            "w-3.5 h-3.5 shrink-0 transition-colors",
            active ? meta.tint : "text-muted-foreground group-hover/tab:text-foreground",
          )}
        />

        <StatusDot status={tab.status} reduced={!!reduced} />

        {/* Latency chip — only visible once the renderer has produced a
            number (or explicitly reported null = unmeasurable). Hidden
            for closed/error so a stale RTT doesn't linger on a dead tab. */}
        {tab.status === "connected" && tab.latencyMs !== undefined && (
          <LatencyBadge ms={tab.latencyMs} />
        )}

        {editingTitle ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                const v = draft.trim()
                if (v) onRenameSubmit(v)
                else onRenameCancel()
              }
              if (e.key === "Escape") {
                e.preventDefault()
                onRenameCancel()
              }
              e.stopPropagation()
            }}
            onBlur={() => {
              const v = draft.trim()
              if (v && v !== tab.title) onRenameSubmit(v)
              else onRenameCancel()
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 bg-transparent outline-none border-b border-primary px-0.5 text-sm"
            spellCheck={false}
          />
        ) : (
          <span className="flex-1 min-w-0 truncate flex items-center gap-1">
            <span className="truncate">{tab.title}</span>
            {tab.status === "connecting" && (
              <Loader2 className="w-3 h-3 animate-spin text-amber-500 shrink-0" aria-hidden />
            )}
          </span>
        )}

        <motion.button
          type="button"
          tabIndex={-1}
          onClick={(ev) => {
            ev.stopPropagation()
            onClose()
          }}
          whileHover={reduced ? undefined : { scale: 1.15 }}
          whileTap={reduced ? undefined : { scale: 0.9 }}
          className={cn(
            "shrink-0 rounded-sm w-4 h-4 inline-flex items-center justify-center",
            "text-muted-foreground hover:text-foreground hover:bg-accent",
            "transition-opacity duration-150",
            active ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover/tab:opacity-100",
          )}
          aria-label={`关闭 ${tab.title}`}
          title="关闭 (Ctrl+W)"
        >
          <X className="w-3 h-3" />
        </motion.button>
      </motion.div>
    </div>
  )
})

// StatusDot — semantic-color dot with motion-driven feedback:
//   fresh       → small muted dot (no animation)
//   connecting  → amber dot that breathes (opacity + scale)
//   connected   → emerald dot with a soft outward ping halo
//   closed      → muted dot
//   error       → destructive dot with a quick attention shake on mount
function StatusDot({
  status,
  reduced,
}: {
  status: WorkspaceTabModel["status"]
  reduced: boolean
}) {
  const base = "w-1.5 h-1.5 rounded-full shrink-0"
  if (status === "connecting" && !reduced) {
    return (
      <motion.span
        aria-label="connecting"
        className={cn(base, "bg-amber-500")}
        animate={{ opacity: [0.4, 1, 0.4], scale: [0.85, 1.1, 0.85] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      />
    )
  }
  if (status === "connected" && !reduced) {
    return (
      <span className="relative inline-flex w-1.5 h-1.5 shrink-0" aria-label="connected">
        <span className="absolute inset-0 rounded-full bg-emerald-500" />
        <motion.span
          className="absolute inset-0 rounded-full bg-emerald-500"
          animate={{ scale: [1, 2.4], opacity: [0.55, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
        />
      </span>
    )
  }
  if (status === "error" && !reduced) {
    return (
      <motion.span
        aria-label="error"
        className={cn(base, "bg-destructive")}
        initial={{ x: 0 }}
        animate={{ x: [0, -1.5, 1.5, -1.5, 1.5, 0] }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      />
    )
  }
  const color = {
    fresh: "bg-muted-foreground/40",
    connecting: "bg-amber-500",
    connected: "bg-emerald-500",
    closed: "bg-muted-foreground/40",
    error: "bg-destructive",
  }[status]
  return <span aria-label={status} className={cn(base, color)} />
}

// LatencyBadge — tiny chip rendering "{ms}ms" next to the status dot.
// Colour mirrors `desktop-status-bar.tsx`'s scheme so the user reads
// the same thresholds on the tab strip and the detail bar:
//
//   ≤ 80 ms   → emerald (snappy)
//   ≤ 200 ms  → amber   (noticeable)
//   ≤ 500 ms  → orange  (laggy)
//   > 500 ms  → red     (painful)
//   null      → "—"     (renderer reports the channel is up but RTT
//                       can't be measured, e.g. IronRDP Wasm path)
function LatencyBadge({ ms }: { ms: number | null }) {
  if (ms == null) {
    return (
      <span
        title="该会话的延迟无法直接测量"
        className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60 leading-none"
      >
        —
      </span>
    )
  }
  const tone =
    ms <= 80
      ? "text-emerald-600 dark:text-emerald-400"
      : ms <= 200
        ? "text-amber-600 dark:text-amber-400"
        : ms <= 500
          ? "text-orange-600 dark:text-orange-400"
          : "text-red-600 dark:text-red-400"
  return (
    <span
      title={`往返延迟 ${ms} ms`}
      className={cn("shrink-0 text-[10px] tabular-nums leading-none", tone)}
    >
      {ms}ms
    </span>
  )
}
