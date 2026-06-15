"use client"

// Workspace tab strip. Phase 7 adds:
//   - grouping (off / manual / by-node / by-protocol) with GroupHeader pills
//   - pinned tabs that always sort to the left and survive close-others
//   - extended ContextMenu (group ops, pin/unpin, copy connection info,
//     restart, mute, pop-out)
//   - Settings entry via a gear button at the strip's end
//
// The rendering layout walks a `Section[]` projection of the tab list so
// the JSX stays declarative. Sections are derived per `groupingMode`:
//   off          → one anonymous section
//   manual       → one section per TabGroup row + one "未分组" tail
//   by-node      → grouped by tab.nodeId
//   by-protocol  → grouped by tab.protocol

import * as React from "react"
import { AnimatePresence, LayoutGroup, useReducedMotion } from "motion/react"
import {
  ArrowLeftRight,
  Columns2,
  Columns3,
  ExternalLink,
  Grid2x2,
  Pin,
  Plus,
  RotateCcw,
  Rows2,
  Settings2,
  SplitSquareHorizontal,
  Volume2,
  VolumeX,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/components/ui/sonner"
import { useQueryClient } from "@tanstack/react-query"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import {
  useWorkspaceStore,
  type Protocol,
  type WorkspaceTab as WorkspaceTabModel,
  type TabGroup,
} from "./useWorkspaceStore"
import { WorkspaceTab } from "./WorkspaceTab"
import { GroupHeader } from "./GroupHeader"
import { GROUP_SWATCH_BG } from "./groupColors"
import { metaOf } from "./protocolMeta"
import { WorkspaceSettingsSheet } from "./WorkspaceSettingsSheet"

type Props = {
  onNewTab: () => void
}

type DragState = {
  fromId: string
  hoverId: string | null
  side: "left" | "right" | null
}

interface Section {
  // null = ungrouped trailing bucket / single section in off mode.
  group: TabGroup | null
  // readOnly when grouping by node/protocol — UI hides edit/delete affordances.
  readOnly: boolean
  tabs: WorkspaceTabModel[]
}

const PROTOCOL_LABEL: Record<Protocol, string> = {
  ssh: "SSH",
  telnet: "Telnet",
  dbcli: "数据库",
  db_studio: "数据库浏览",
  rdp: "RDP",
  rdp_next: "RDP (新)",
  vnc: "VNC",
  sftp: "SFTP",
  oss: "对象存储",
  tcp_forward: "端口转发",
}

export function WorkspaceTabBar({ onNewTab }: Props) {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const groups = useWorkspaceStore((s) => s.groups)
  const groupingMode = useWorkspaceStore((s) => s.prefs.groupingMode)
  const tabStyle = useWorkspaceStore((s) => s.prefs.tabStyle)
  const isWarp = tabStyle === "warp"
  const activeId = useWorkspaceStore((s) => s.activeId)
  const setActive = useWorkspaceStore((s) => s.setActive)
  const close = useWorkspaceStore((s) => s.close)
  const closeOthers = useWorkspaceStore((s) => s.closeOthers)
  const closeToRight = useWorkspaceStore((s) => s.closeToRight)
  const duplicate = useWorkspaceStore((s) => s.duplicate)
  const renameTab = useWorkspaceStore((s) => s.rename)
  const reorder = useWorkspaceStore((s) => s.reorder)
  const togglePin = useWorkspaceStore((s) => s.togglePin)
  const toggleMute = useWorkspaceStore((s) => s.toggleMute)
  const setPoppedOut = useWorkspaceStore((s) => s.setPoppedOut)
  const setStatus = useWorkspaceStore((s) => s.setStatus)
  const createGroup = useWorkspaceStore((s) => s.createGroup)
  const moveTabToGroup = useWorkspaceStore((s) => s.moveTabToGroup)
  const split = useWorkspaceStore((s) => s.split)
  const setSplit = useWorkspaceStore((s) => s.setSplit)
  const toggleSplit = useWorkspaceStore((s) => s.toggleSplit)
  const swapSplit = useWorkspaceStore((s) => s.swapSplit)
  const setLayout = useWorkspaceStore((s) => s.setLayout)
  // A tab is a "secondary" pane when it's in the grid but not the primary slot.
  const isSecondaryPane = (id: string) =>
    split.layout !== "single" && split.slots.includes(id) && split.slots[0] !== id

  const qc = useQueryClient()
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [drag, setDrag] = React.useState<DragState | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  const onDragStart = (id: string) => (ev: React.DragEvent) => {
    ev.dataTransfer.effectAllowed = "move"
    ev.dataTransfer.setData("text/plain", id)
    setDrag({ fromId: id, hoverId: null, side: null })
  }
  const onDragOver = (id: string) => (ev: React.DragEvent) => {
    if (!drag) return
    ev.preventDefault()
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    const side: "left" | "right" = ev.clientX - rect.left < rect.width / 2 ? "left" : "right"
    if (drag.hoverId !== id || drag.side !== side) {
      setDrag({ ...drag, hoverId: id, side })
    }
  }
  const onDrop = (id: string) => (ev: React.DragEvent) => {
    if (!drag) return
    ev.preventDefault()
    const fromIdx = tabs.findIndex((t) => t.id === drag.fromId)
    let toIdx = tabs.findIndex((t) => t.id === id)
    if (fromIdx < 0 || toIdx < 0) {
      setDrag(null)
      return
    }
    // Cross-group drag (manual mode): dropping onto a tab in another group
    // adopts that group before reordering, so a drag can both move and regroup.
    if (groupingMode === "manual") {
      const fromGroup = tabs[fromIdx].groupId ?? null
      const toGroup = tabs[toIdx].groupId ?? null
      if (fromGroup !== toGroup) moveTabToGroup(drag.fromId, toGroup)
    }
    if (drag.side === "right") toIdx++
    if (fromIdx < toIdx) toIdx--
    reorder(fromIdx, toIdx)
    setDrag(null)
  }
  const onDragEnd = () => setDrag(null)

  const sections = React.useMemo<Section[]>(
    () => buildSections(tabs, groups, groupingMode),
    [tabs, groups, groupingMode],
  )

  const reduced = useReducedMotion()

  // ----- overflow scrolling -----
  // The strip hides its native scrollbar (no-scrollbar) and is driven by the
  // wheel + drag + edge-fade affordances below, so overflowing tabs stay
  // reachable without a system scrollbar on screen.
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const [edges, setEdges] = React.useState({ left: false, right: false })

  const updateEdges = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  // Background-independent edge fade: a CSS mask fades the tabs to transparent
  // only on the side that can actually scroll, so overflow reads cleanly
  // regardless of the strip colour (a gradient overlay would have to match it).
  const maskStyle = React.useMemo<React.CSSProperties>(() => {
    const l = edges.left ? "transparent 0, black 24px" : "black 0, black 24px"
    const r = edges.right ? "black calc(100% - 24px), transparent 100%" : "black calc(100% - 24px), black 100%"
    const g = `linear-gradient(to right, ${l}, ${r})`
    return { WebkitMaskImage: g, maskImage: g }
  }, [edges.left, edges.right])

  // Vertical wheel → horizontal scroll. Non-passive so we can preventDefault
  // and stop the page scrolling while the cursor is over the strip; only
  // hijacked when there is real horizontal overflow.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
      updateEdges()
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [updateEdges])

  // Recompute fade edges on mount / resize / tab-set changes (open, close,
  // reorder, group collapse all change overflow).
  React.useEffect(() => {
    updateEdges()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(updateEdges)
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateEdges, tabs.length, sections.length])

  // Keep the active tab visible when it changes (keyboard switch, new tab,
  // duplicate). `inline:nearest` avoids yanking the strip when it's already
  // in view.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el || !activeId) return
    const node = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`)
    node?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reduced ? "auto" : "smooth" })
  }, [activeId, reduced])

  const handleCopyAddress = React.useCallback((tab: WorkspaceTabModel) => {
    if (!tab.host || !tab.port) {
      toast.error("该 Tab 未记录连接地址")
      return
    }
    const value = `${tab.host}:${tab.port}`
    void navigator.clipboard?.writeText(value).then(
      () => toast.success("已复制地址", { description: value }),
      () => toast.error("复制失败"),
    )
  }, [])

  const handleCopySSH = React.useCallback((tab: WorkspaceTabModel) => {
    if (!tab.host) return
    const port = tab.port ?? 22
    const cmd = port === 22 ? `ssh ${tab.host}` : `ssh -p ${port} ${tab.host}`
    void navigator.clipboard?.writeText(cmd).then(
      () => toast.success("已复制 SSH 命令", { description: cmd }),
      () => toast.error("复制失败"),
    )
  }, [])

  const handleRestart = React.useCallback(
    (tab: WorkspaceTabModel) => {
      setStatus(tab.id, "connecting")
      // The per-protocol component (webssh-terminal, desktop-display, etc.)
      // watches the tab's `status` transition and re-establishes the WS on
      // its own. The client-side invalidation here also nudges any cached
      // session info that the new connection might want to consult.
      void qc.invalidateQueries({ queryKey: ["session", tab.id] })
      toast.success("重新连接", { description: tab.title })
    },
    [qc, setStatus],
  )

  const handlePopOut = React.useCallback(
    (tab: WorkspaceTabModel) => {
      const params = new URLSearchParams({ tab: tab.id, popout: "1" })
      const win = window.open(
        `/workspace?${params.toString()}`,
        `workspace-${tab.id}`,
        "width=1280,height=800",
      )
      if (!win) {
        toast.error("浏览器拦截了弹出窗口")
        return
      }
      setPoppedOut(tab.id, true)
      toast.success("已弹出新窗口", { description: tab.title })
    },
    [setPoppedOut],
  )

  return (
    <>
      <div className={cn("relative flex items-stretch h-9", isWarp ? "bg-background" : "bg-muted/30")}>
        {/* Scroll viewport — native scrollbar hidden (no-scrollbar); the wheel
            handler + a side-aware CSS mask keep overflowing tabs reachable and
            cleanly faded without a system scrollbar on screen.
              vscode → 满高矩形页贴合条底,无间距(分隔线由页右边框给出);
              warp   → 圆角段居中,留 4px 段间距。 */}
        <div className="relative flex-1 min-w-0">
          <div
            ref={scrollRef}
            role="tablist"
            aria-label="工作台 Tabs"
            onScroll={updateEdges}
            style={maskStyle}
            className={cn(
              "flex h-full overflow-x-auto overflow-y-hidden no-scrollbar",
              isWarp ? "items-center gap-1 px-1.5" : "items-stretch gap-0 px-0",
            )}
          >
            <LayoutGroup id="workspace-tabs">
          <AnimatePresence initial={false} mode="popLayout">
            {sections.map((section, sIdx) => (
              <SectionBlock
                key={section.group?.id ?? `section-${sIdx}`}
                section={section}
                renderTab={(tab) => (
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <WorkspaceTab
                        tab={tab}
                        active={tab.id === activeId}
                        editingTitle={renamingId === tab.id}
                        onActivate={() => setActive(tab.id)}
                        onClose={() => close(tab.id)}
                        onContextMenu={(ev) => ev.preventDefault()}
                        onDoubleClick={() => setRenamingId(tab.id)}
                        onRenameSubmit={(v) => {
                          renameTab(tab.id, v)
                          setRenamingId(null)
                        }}
                        onRenameCancel={() => setRenamingId(null)}
                        onDragStart={onDragStart(tab.id)}
                        onDragOver={onDragOver(tab.id)}
                        onDrop={onDrop(tab.id)}
                        onDragEnd={onDragEnd}
                        dragOver={drag && drag.hoverId === tab.id ? drag.side : null}
                        dragging={drag?.fromId === tab.id}
                      />
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-56">
                      {/* Close cluster — keyboard shortcuts mirror the
                          chrome-style binding registered in WorkspaceShell. */}
                      <ContextMenuItem
                        onSelect={() => close(tab.id)}
                        disabled={tab.pinned}
                      >
                        关闭
                        <ContextMenuShortcut>Ctrl+W</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => closeOthers(tab.id)}>
                        关闭其他
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => closeToRight(tab.id)}>
                        关闭右侧
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => duplicate(tab.id)}>
                        复制 Tab
                        <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => setRenamingId(tab.id)}>
                        重命名
                        <ContextMenuShortcut>F2</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => togglePin(tab.id)}>
                        <Pin className={cn("w-4 h-4", tab.pinned ? "fill-current" : "")} />
                        {tab.pinned ? "取消固定" : "固定 Tab"}
                        <ContextMenuShortcut>Ctrl+Shift+P</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => toggleMute(tab.id)}>
                        {tab.muted ? (
                          <>
                            <Volume2 className="w-4 h-4" /> 取消静音
                          </>
                        ) : (
                          <>
                            <VolumeX className="w-4 h-4" /> 静音通知
                          </>
                        )}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>添加到分组</ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-48">
                          {groups.length === 0 ? (
                            <ContextMenuItem disabled>暂无分组</ContextMenuItem>
                          ) : (
                            groups.map((g) => (
                              <ContextMenuItem
                                key={g.id}
                                onSelect={() => moveTabToGroup(tab.id, g.id)}
                              >
                                <span
                                  className={cn(
                                    "inline-block w-2.5 h-2.5 rounded-full mr-2",
                                    GROUP_SWATCH_BG[g.color],
                                  )}
                                />
                                {g.name}
                                {tab.groupId === g.id ? (
                                  <ContextMenuShortcut>当前</ContextMenuShortcut>
                                ) : null}
                              </ContextMenuItem>
                            ))
                          )}
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onSelect={() => {
                              const name = window.prompt("新分组名称", "新分组")
                              if (!name) return
                              const gid = createGroup(name)
                              moveTabToGroup(tab.id, gid)
                            }}
                          >
                            新建分组…
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      {tab.groupId ? (
                        <ContextMenuItem onSelect={() => moveTabToGroup(tab.id, null)}>
                          移出分组
                        </ContextMenuItem>
                      ) : null}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => handleCopyAddress(tab)}
                        disabled={!tab.host || !tab.port}
                      >
                        复制 host:port
                      </ContextMenuItem>
                      {tab.protocol === "ssh" ? (
                        <ContextMenuItem
                          onSelect={() => handleCopySSH(tab)}
                          disabled={!tab.host}
                        >
                          复制 SSH 命令
                        </ContextMenuItem>
                      ) : null}
                      <ContextMenuItem onSelect={() => handleRestart(tab)}>
                        <RotateCcw className="w-4 h-4" /> 重启连接
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          if (isSecondaryPane(tab.id)) setSplit(null)
                          else if (tab.id === activeId) toggleSplit()
                          else setSplit(tab.id)
                        }}
                        disabled={tabs.length < 2}
                      >
                        <SplitSquareHorizontal className="w-4 h-4" />
                        {isSecondaryPane(tab.id) ? "取消并排" : "并排查看"}
                        <ContextMenuShortcut>Ctrl+\</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => handlePopOut(tab)}
                        disabled={tab.poppedOut}
                      >
                        <ExternalLink className="w-4 h-4" /> 在新窗口打开
                        <ContextMenuShortcut>Ctrl+Shift+N</ContextMenuShortcut>
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )}
              />
            ))}
            </AnimatePresence>
            </LayoutGroup>
          </div>
        </div>
        {/* Pinned action area — stays put when tabs overflow (previously it
            scrolled off with the strip). A divider sets it apart from tabs. */}
        <div className="shrink-0 flex items-center gap-0.5 px-1.5 border-l border-border/40">
          <button
            type="button"
            onClick={onNewTab}
            title="新建 Tab (Ctrl+T)"
            aria-label="新建 Tab"
            className={cn(
              "shrink-0 flex items-center justify-center h-7 w-7 text-muted-foreground rounded-md",
              "hover:bg-accent hover:text-foreground transition-colors",
            )}
          >
            <Plus className="w-4 h-4" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title="分屏 (Ctrl+\)"
                aria-label="分屏"
                className={cn(
                  "shrink-0 flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                  split.layout !== "single"
                    ? "bg-primary/12 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <SplitSquareHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onSelect={() => toggleSplit()}
                disabled={split.layout === "single" && tabs.length < 2}
              >
                <SplitSquareHorizontal className="h-4 w-4" />
                {split.layout === "single" ? "并排查看" : "取消并排"}
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">Ctrl \</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setLayout("row-2")} disabled={tabs.length < 2}>
                <Columns2 className="h-4 w-4" /> 左右两栏
                {split.layout === "row-2" && <span className="ml-auto text-primary">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLayout("col-2")} disabled={tabs.length < 2}>
                <Rows2 className="h-4 w-4" /> 上下两栏
                {split.layout === "col-2" && <span className="ml-auto text-primary">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLayout("row-3")} disabled={tabs.length < 3}>
                <Columns3 className="h-4 w-4" /> 三栏
                {split.layout === "row-3" && <span className="ml-auto text-primary">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setLayout("grid-4")} disabled={tabs.length < 4}>
                <Grid2x2 className="h-4 w-4" /> 田字（四格）
                {split.layout === "grid-4" && <span className="ml-auto text-primary">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => swapSplit()} disabled={split.layout === "single"}>
                <ArrowLeftRight className="h-4 w-4" /> 交换主副
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="工作台设置"
            aria-label="工作台设置"
            className={cn(
              "shrink-0 flex items-center justify-center h-7 w-7 text-muted-foreground rounded-md",
              "hover:bg-accent hover:text-foreground transition-colors",
            )}
          >
            <Settings2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      <WorkspaceSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  )
}

function SectionBlock({
  section,
  renderTab,
}: {
  section: Section
  renderTab: (tab: WorkspaceTabModel) => React.ReactNode
}) {
  return (
    <>
      {section.group ? (
        <GroupHeader
          group={section.group}
          count={section.tabs.length}
          readOnly={section.readOnly}
        />
      ) : null}
      {section.group?.collapsed
        ? null
        : section.tabs.map((tab) => (
            <React.Fragment key={tab.id}>{renderTab(tab)}</React.Fragment>
          ))}
    </>
  )
}

function buildSections(
  tabs: WorkspaceTabModel[],
  groups: TabGroup[],
  mode: ReturnType<typeof useWorkspaceStore.getState>["prefs"]["groupingMode"],
): Section[] {
  if (mode === "off" || tabs.length === 0) {
    return [{ group: null, readOnly: false, tabs: [...tabs] }]
  }
  if (mode === "manual") {
    const byGroup = new Map<string, WorkspaceTabModel[]>()
    const ungrouped: WorkspaceTabModel[] = []
    for (const t of tabs) {
      if (t.groupId && groups.find((g) => g.id === t.groupId)) {
        const list = byGroup.get(t.groupId) ?? []
        list.push(t)
        byGroup.set(t.groupId, list)
      } else {
        ungrouped.push(t)
      }
    }
    const sections: Section[] = []
    for (const g of groups) {
      const list = byGroup.get(g.id)
      if (!list || list.length === 0) continue
      sections.push({ group: g, readOnly: false, tabs: list })
    }
    if (ungrouped.length > 0) {
      sections.push({ group: null, readOnly: false, tabs: ungrouped })
    }
    return sections
  }
  if (mode === "by-node") {
    const byNode = new Map<number, WorkspaceTabModel[]>()
    for (const t of tabs) {
      const list = byNode.get(t.nodeId) ?? []
      list.push(t)
      byNode.set(t.nodeId, list)
    }
    return Array.from(byNode.entries()).map(([nodeId, list]) => ({
      group: {
        id: `node-${nodeId}`,
        name: list[0]?.host ? `${list[0].host}` : `节点 ${nodeId}`,
        color: pickColorByKey(`node-${nodeId}`),
        collapsed: false,
      },
      readOnly: true,
      tabs: list,
    }))
  }
  // by-protocol
  const byProto = new Map<Protocol, WorkspaceTabModel[]>()
  for (const t of tabs) {
    const list = byProto.get(t.protocol) ?? []
    list.push(t)
    byProto.set(t.protocol, list)
  }
  return Array.from(byProto.entries()).map(([proto, list]) => ({
    group: {
      id: `proto-${proto}`,
      name: PROTOCOL_LABEL[proto] ?? metaOf(proto).label,
      color: pickColorByKey(`proto-${proto}`),
      collapsed: false,
    },
    readOnly: true,
    tabs: list,
  }))
}

// Stable palette pick from an arbitrary string key. Keeps derived groups
// (per-node, per-protocol) visually consistent across renders without
// having to persist the choice.
function pickColorByKey(key: string): TabGroup["color"] {
  const order: TabGroup["color"][] = [
    "blue", "green", "purple", "orange", "red", "cyan", "yellow", "gray",
  ]
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0
  return order[Math.abs(h) % order.length]
}
