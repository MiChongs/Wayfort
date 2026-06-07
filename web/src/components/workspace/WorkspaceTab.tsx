"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { ExternalLink, Loader2, Pin, SplitSquareHorizontal, VolumeX, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkspaceTab as WorkspaceTabModel } from "./useWorkspaceStore"
import { useWorkspaceStore } from "./useWorkspaceStore"
import { metaOf, rdpBackendShortLabel } from "./protocolMeta"
import { GROUP_ACCENT_BG } from "./groupColors"
import { STATUS_DOT, STATUS_LABEL, latencyTone } from "./tabStatus"

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
  /** True while THIS tab is the one being dragged — dims it so the drop
   *  indicator on the target reads as the live insertion point. */
  dragging?: boolean
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
    dragging,
    ...rest
  },
  ref,
) {
  const meta = metaOf(tab.protocol)
  const rdpBackendLabel = tab.protocol === "rdp_next" ? rdpBackendShortLabel(tab.rdpBackend) : null
  const Icon = meta.icon
  const reduced = useReducedMotion()
  const [draft, setDraft] = React.useState(tab.title)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const prefs = useWorkspaceStore((s) => s.prefs)
  const groups = useWorkspaceStore((s) => s.groups)
  // This tab is the split's secondary pane (the primary pane is the active tab,
  // already styled as the floating card).
  const inSplit = useWorkspaceStore((s) => s.splitId === tab.id) && !active
  // Only render the group accent in manual mode — the derived modes are
  // implied by adjacency in the strip, so a coloured stripe would be
  // visual noise rather than information.
  const groupAccent = React.useMemo(() => {
    if (prefs.groupingMode !== "manual" || !tab.groupId) return null
    return groups.find((g) => g.id === tab.groupId)?.color ?? null
  }, [prefs.groupingMode, tab.groupId, groups])

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
      className="contents"
      {...rest}
    >
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <motion.div
            data-tab-id={tab.id}
            layout={!reduced}
            initial={reduced ? false : { opacity: 0, scale: 0.96, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, scale: 0.92, y: 4 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className={cn(
              "group/tab relative flex items-center gap-1.5 shrink-0 self-end rounded-t-lg",
              // 紧凑密度
              tab.pinned ? "px-2 min-w-[52px] max-w-[104px]" : "px-2.5 min-w-[116px] max-w-[210px]",
              "text-[13px] cursor-default select-none transition-[background-color,color,height,opacity] duration-150",
              active
                // Chrome 浮起卡片：与下方 bg-background 内容区同色，圆角顶 + 阴影 + 描边 + 2px 主题色顶边，占满条高并浮起
                ? "h-full bg-background text-foreground shadow-sm border border-b-0 border-border/60 border-t-2 border-t-primary z-10"
                // 非激活：扭平、偏灰、略矮（让激活卡片显得浮起），hover 才变亮
                : "h-[calc(100%-3px)] bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              dragging && "opacity-40",
            )}
          >
        {/* Drop insertion marker — a glowing full-height bar in the gap on the
            drop side, capped with a dot so the insertion point reads clearly. */}
        {dragOver && (
          <motion.span
            aria-hidden
            initial={{ opacity: 0, scaleY: 0.5 }}
            animate={{ opacity: 1, scaleY: 1 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className={cn(
              "absolute top-0 bottom-0 z-10 w-[3px] rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60",
              dragOver === "left" ? "-left-px" : "-right-px",
            )}
          >
            <span className="absolute -top-[3px] left-1/2 -translate-x-1/2 h-1.5 w-1.5 rounded-full bg-primary" />
          </motion.span>
        )}

        {/* Manual-mode group accent — bottom stripe in the group's hue. */}
        {groupAccent && (
          <span
            className={cn(
              "absolute inset-x-0 bottom-0 h-[2px]",
              GROUP_ACCENT_BG[groupAccent],
            )}
          />
        )}

        {tab.pinned ? (
          <Pin className="w-3 h-3 shrink-0 text-primary fill-primary" aria-label="pinned" />
        ) : prefs.showProtocolIcon ? (
          <Icon
            className={cn(
              "w-3.5 h-3.5 shrink-0 transition-colors",
              active ? meta.tint : "text-muted-foreground group-hover/tab:text-foreground",
            )}
          />
        ) : null}

        <StatusDot status={tab.status} reduced={!!reduced} />

        {/* Latency chip — only visible once the renderer has produced a
            number (or explicitly reported null = unmeasurable). Hidden
            for closed/error so a stale RTT doesn't linger on a dead tab,
            and dropped entirely when the user disabled the badge. */}
        {!tab.pinned &&
          prefs.showLatencyBadge &&
          tab.status === "connected" &&
          tab.latencyMs !== undefined && <LatencyBadge ms={tab.latencyMs} />}

        {/* Mute / popped-out badges — small icons that the ContextMenu can
            toggle. Hidden on pinned tabs because the row is already
            compressed to icon + close. */}
        {!tab.pinned && tab.muted && (
          <VolumeX className="w-3 h-3 shrink-0 text-muted-foreground/80" aria-label="已静音通知" />
        )}
        {!tab.pinned && tab.poppedOut && (
          <ExternalLink className="w-3 h-3 shrink-0 text-primary" aria-label="已弹出到新窗口" />
        )}
        {!tab.pinned && inSplit && (
          <SplitSquareHorizontal className="w-3 h-3 shrink-0 text-primary" aria-label="并排显示中" />
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
        ) : tab.pinned ? null : (
          <span className="flex-1 min-w-0 truncate flex items-center gap-1">
            <motion.span
              layout={!reduced}
              layoutId={`workspace-tab-title-${tab.id}`}
              className="truncate"
            >
              {tab.title}
            </motion.span>
            {tab.unread && (
              <motion.span
                aria-label="活动"
                className="shrink-0 inline-flex w-1.5 h-1.5 rounded-full bg-primary"
                initial={reduced ? undefined : { scale: 0 }}
                animate={{ scale: 1 }}
              />
            )}
            {rdpBackendLabel && (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] leading-none text-muted-foreground">
                {rdpBackendLabel}
              </span>
            )}
            {tab.status === "connecting" && (
              <Loader2 className="w-3 h-3 animate-spin text-[#c08a2e] dark:text-[#e3b84e] shrink-0" aria-hidden />
            )}
          </span>
        )}

        {/* Close button — always visible (pinned tabs survive by design, so
            their X is hidden until unpinned via the ContextMenu). */}
        {!tab.pinned && (
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
              active ? "opacity-80 hover:opacity-100" : "opacity-50 hover:opacity-100",
            )}
            aria-label={`关闭 ${tab.title}`}
            title="关闭 (Ctrl+W)"
          >
            <X className="w-3 h-3" />
          </motion.button>
        )}
          </motion.div>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" sideOffset={6} className="max-w-[260px]">
          <TabPreview tab={tab} rdpBackendLabel={rdpBackendLabel} />
        </TooltipContent>
      </Tooltip>
    </div>
  )
})

// TabPreview — the rich hover bubble surfaced by the tab-level Tooltip. Pulls
// title, protocol, address, live status + latency, and state flags into one
// place so the strip itself stays compact.
function TabPreview({
  tab,
  rdpBackendLabel,
}: {
  tab: WorkspaceTabModel
  rdpBackendLabel: string | null
}) {
  const meta = metaOf(tab.protocol)
  return (
    <div className="space-y-1 text-xs">
      <div className="text-sm font-medium leading-tight">{tab.title}</div>
      <div className="text-muted-foreground">
        {meta.label}
        {rdpBackendLabel ? ` · ${rdpBackendLabel}` : ""}
      </div>
      {tab.host ? (
        <div className="font-mono text-[11px] text-muted-foreground">
          {tab.host}
          {tab.port ? `:${tab.port}` : ""}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 pt-0.5">
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", STATUS_DOT[tab.status])} />
        <span>{STATUS_LABEL[tab.status]}</span>
        {tab.status === "connected" && tab.latencyMs != null ? (
          <span className="tabular-nums text-muted-foreground">· {tab.latencyMs}ms</span>
        ) : null}
      </div>
      {tab.pinned || tab.muted || tab.poppedOut ? (
        <div className="flex items-center gap-2 pt-0.5 text-[11px] text-muted-foreground">
          {tab.pinned ? <span>已固定</span> : null}
          {tab.muted ? <span>已静音</span> : null}
          {tab.poppedOut ? <span>已弹出</span> : null}
        </div>
      ) : null}
    </div>
  )
}

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
        className={cn(base, STATUS_DOT.connecting)}
        animate={{ opacity: [0.4, 1, 0.4], scale: [0.85, 1.1, 0.85] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      />
    )
  }
  if (status === "connected" && !reduced) {
    return (
      <span className="relative inline-flex w-1.5 h-1.5 shrink-0" aria-label="connected">
        <span className={cn("absolute inset-0 rounded-full", STATUS_DOT.connected)} />
        <motion.span
          className={cn("absolute inset-0 rounded-full", STATUS_DOT.connected)}
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
        className={cn(base, STATUS_DOT.error)}
        initial={{ x: 0 }}
        animate={{ x: [0, -1.5, 1.5, -1.5, 1.5, 0] }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      />
    )
  }
  if (status === "approval" && !reduced) {
    return (
      <motion.span
        aria-label="approval"
        className={cn(base, STATUS_DOT.approval)}
        animate={{ opacity: [0.45, 1, 0.45] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      />
    )
  }
  return <span aria-label={status} className={cn(base, STATUS_DOT[status])} />
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
  return (
    <span
      title={`往返延迟 ${ms} ms`}
      className={cn("shrink-0 text-[10px] tabular-nums leading-none", latencyTone(ms))}
    >
      {ms}ms
    </span>
  )
}
