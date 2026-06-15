"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { ExternalLink, Loader2, Pin, SplitSquareHorizontal, VolumeX, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkspaceTab as WorkspaceTabModel } from "./useWorkspaceStore"
import { useWorkspaceStore } from "./useWorkspaceStore"
import { useRuntimeStore } from "./useRuntimeStore"
import { metaOf, rdpBackendShortLabel } from "./protocolMeta"
import { GROUP_SWATCH_BG } from "./groupColors"
import { STATUS_DOT, STATUS_LABEL } from "./tabStatus"

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

// WorkspaceTab — 沉稳 IDE 风格的页签,两种 idiom 由 prefs.tabStyle 切换:
//   vscode → 满高矩形页,激活 = 左侧 2px 主题色竖条 + 内容色填充。
//   warp   → 圆角段,激活 = 填充 + 内描边 + 底部 2px 主题色下划线。
// 共同纪律(去花哨):单色协议图标、静态语义状态点(无呼吸/光晕/抖动)、
// 单色延迟、关闭按钮无缩放、仅 120ms 淡入进出场。
// 外层 div 负责 HTML 拖放 + 点击(motion 手势类型与 React DragEvent 冲突),
// 内层 motion.div 仅做视觉:布局动画与淡入。
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
  const isWarp = prefs.tabStyle === "warp"
  // This tab is the split's secondary pane (the primary pane is the active tab,
  // already styled as the floating card).
  const inSplit = useWorkspaceStore(
    (s) => s.split.layout !== "single" && s.split.slots.indexOf(tab.id) > 0,
  )
  // Only render the group accent in manual mode — the derived modes are
  // implied by adjacency in the strip, so a coloured marker would be
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
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className={cn(
              "group/tab relative flex items-center gap-1.5 shrink-0",
              "text-[13px] cursor-default select-none transition-[background-color,color] duration-150",
              // 尺寸 / 形状 —— 两种 idiom
              isWarp
                ? "self-center h-7 rounded-lg"
                : "self-stretch h-full rounded-none border-r border-border/60",
              // 内边距(固定页更窄)
              tab.pinned
                ? isWarp
                  ? "px-2 min-w-[48px] max-w-[100px]"
                  : "px-2.5 min-w-[52px] max-w-[104px]"
                : isWarp
                  ? "px-2.5 min-w-[116px] max-w-[210px]"
                  : "px-3 min-w-[120px] max-w-[210px]",
              // 激活 / 非激活填充
              active
                ? isWarp
                  ? "bg-secondary text-foreground ring-1 ring-inset ring-border"
                  : "bg-background text-foreground"
                : "bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
              dragging && "opacity-40",
            )}
          >
        {/* 激活指示条 —— vscode 左竖条 / warp 底部下划线。无阴影、无光晕。 */}
        {active && !isWarp && (
          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-primary" />
        )}
        {active && isWarp && (
          <span aria-hidden className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-primary" />
        )}

        {/* 拖放插入标记 —— 仅一条 2px 主题色线,去掉发光与端点圆点。 */}
        {dragOver && (
          <span
            aria-hidden
            className={cn(
              "absolute top-0 bottom-0 z-10 w-[2px] rounded-full bg-primary",
              dragOver === "left" ? "-left-px" : "-right-px",
            )}
          />
        )}

        {/* 手动分组标记 —— 起始处一个组色小圆点(替代旧的彩色底条)。 */}
        {groupAccent && (
          <span
            aria-hidden
            className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", GROUP_SWATCH_BG[groupAccent])}
          />
        )}

        {tab.pinned ? (
          <Pin className="w-3 h-3 shrink-0 text-primary fill-primary" aria-label="pinned" />
        ) : prefs.showProtocolIcon ? (
          <Icon
            className={cn(
              "w-3.5 h-3.5 shrink-0 transition-colors",
              active ? "text-foreground" : "text-muted-foreground group-hover/tab:text-foreground",
            )}
          />
        ) : null}

        <StatusDot status={tab.status} />

        {/* Latency chip — only visible once the renderer has produced a
            number (or explicitly reported null = unmeasurable). Hidden
            for closed/error so a stale RTT doesn't linger on a dead tab,
            and dropped entirely when the user disabled the badge. */}
        {!tab.pinned &&
          prefs.showLatencyBadge &&
          tab.status === "connected" && <LatencyBadge tabId={tab.id} />}

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
            <span className="truncate">{tab.title}</span>
            {tab.unread && (
              <span
                aria-label="活动"
                className="shrink-0 inline-flex w-1.5 h-1.5 rounded-full bg-primary"
              />
            )}
            {rdpBackendLabel && (
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] leading-none text-muted-foreground">
                {rdpBackendLabel}
              </span>
            )}
            {tab.status === "connecting" && (
              <Loader2 className="w-3 h-3 animate-spin text-warning shrink-0" aria-hidden />
            )}
          </span>
        )}

        {/* Close button — always visible (pinned tabs survive by design, so
            their X is hidden until unpinned via the ContextMenu). No scale
            gesture — plain color/opacity transitions only. */}
        {!tab.pinned && (
          <button
            type="button"
            tabIndex={-1}
            onClick={(ev) => {
              ev.stopPropagation()
              onClose()
            }}
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
          </button>
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
  const ms = useRuntimeStore((s) => s.latency[tab.id])
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
        {tab.status === "connected" && ms != null ? (
          <span className="tabular-nums text-muted-foreground">· {ms}ms</span>
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

// StatusDot — 静态语义色圆点。去掉了旧版的呼吸 / 外扩光晕 / 抖动动画,
// 让页签保持安静;连接中的「进行中」感由标题旁的 Loader2 spinner 承担。
function StatusDot({ status }: { status: WorkspaceTabModel["status"] }) {
  return <span aria-label={status} className={cn("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[status])} />
}

// LatencyBadge — tiny "{ms}ms" chip next to the status dot. Deliberately a
// single muted tone (not the old red/amber/green scale): the status dot
// already carries health; the number is reference, not an alarm.
function LatencyBadge({ tabId }: { tabId: string }) {
  const ms = useRuntimeStore((s) => s.latency[tabId])
  // Never reported yet — keep the strip clean until the renderer pushes its
  // first RTT sample.
  if (ms === undefined) return null
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
    <span title={`往返延迟 ${ms} ms`} className="shrink-0 text-[10px] tabular-nums leading-none text-muted-foreground">
      {ms}ms
    </span>
  )
}
