"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { useWorkspaceStore } from "./useWorkspaceStore"
import { WorkspaceTab } from "./WorkspaceTab"

type Props = {
  onNewTab: () => void
}

type DragState = {
  fromId: string
  hoverId: string | null
  side: "left" | "right" | null
}

export function WorkspaceTabBar({ onNewTab }: Props) {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const setActive = useWorkspaceStore((s) => s.setActive)
  const close = useWorkspaceStore((s) => s.close)
  const closeOthers = useWorkspaceStore((s) => s.closeOthers)
  const closeToRight = useWorkspaceStore((s) => s.closeToRight)
  const duplicate = useWorkspaceStore((s) => s.duplicate)
  const renameTab = useWorkspaceStore((s) => s.rename)
  const reorder = useWorkspaceStore((s) => s.reorder)

  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [drag, setDrag] = React.useState<DragState | null>(null)

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

  return (
    <div
      role="tablist"
      aria-label="工作台 Tabs"
      className="flex items-stretch border-b bg-background h-9 overflow-x-auto overflow-y-hidden scrollbar-thin"
    >
      {tabs.map((tab) => (
        <ContextMenu key={tab.id}>
          <ContextMenuTrigger asChild>
            <div className="contents">
              <WorkspaceTab
                tab={tab}
                active={tab.id === activeId}
                editingTitle={renamingId === tab.id}
                onActivate={() => setActive(tab.id)}
                onClose={() => close(tab.id)}
                // Radix ContextMenuTrigger handles right-click; the
                // explicit handler here is kept to swallow the legacy
                // bubble so an outer listener doesn't see it.
                onContextMenu={(ev) => {
                  ev.preventDefault()
                }}
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
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => close(tab.id)}>
              关闭
              <ContextMenuShortcut>Ctrl+W</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => closeOthers(tab.id)}>关闭其他</ContextMenuItem>
            <ContextMenuItem onSelect={() => closeToRight(tab.id)}>关闭右侧</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => duplicate(tab.id)}>复制 Tab</ContextMenuItem>
            <ContextMenuItem onSelect={() => setRenamingId(tab.id)}>
              重命名
              <ContextMenuShortcut>双击</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      <button
        type="button"
        onClick={onNewTab}
        title="新建 Tab (Ctrl+T)"
        className={cn(
          "shrink-0 flex items-center justify-center h-9 w-9 text-muted-foreground",
          "hover:bg-accent hover:text-foreground transition-colors",
        )}
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  )
}
