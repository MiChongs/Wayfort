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
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react"
import {
  ExternalLink,
  Pin,
  Plus,
  RotateCcw,
  Settings2,
  Volume2,
  VolumeX,
} from "lucide-react"
import { toast } from "sonner"
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
  tcp_forward: "端口转发",
}

export function WorkspaceTabBar({ onNewTab }: Props) {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const groups = useWorkspaceStore((s) => s.groups)
  const groupingMode = useWorkspaceStore((s) => s.prefs.groupingMode)
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
    if (fromIdx < 0 || toIdx < 0) return
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
      <div
        role="tablist"
        aria-label="工作台 Tabs"
        className={cn(
          "flex items-stretch border-b bg-background h-9",
          "overflow-x-auto overflow-y-hidden scrollbar-thin",
          "[scrollbar-gutter:stable]",
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
        <div className="ml-auto flex items-center gap-1 pr-1">
          <motion.button
            type="button"
            onClick={onNewTab}
            whileHover={reduced ? undefined : { scale: 1.08 }}
            whileTap={reduced ? undefined : { scale: 0.92 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            title="新建 Tab (Ctrl+T)"
            aria-label="新建 Tab"
            className={cn(
              "shrink-0 flex items-center justify-center h-8 w-8 text-muted-foreground rounded-md",
              "hover:bg-accent hover:text-foreground transition-colors",
            )}
          >
            <Plus className="w-4 h-4" />
          </motion.button>
          <motion.button
            type="button"
            onClick={() => setSettingsOpen(true)}
            whileHover={reduced ? undefined : { scale: 1.08 }}
            whileTap={reduced ? undefined : { scale: 0.92 }}
            title="工作台设置"
            aria-label="工作台设置"
            className={cn(
              "shrink-0 flex items-center justify-center h-8 w-8 text-muted-foreground rounded-md",
              "hover:bg-accent hover:text-foreground transition-colors",
            )}
          >
            <Settings2 className="w-4 h-4" />
          </motion.button>
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
