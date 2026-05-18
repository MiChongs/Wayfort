"use client"

import * as React from "react"
import { Plus } from "lucide-react"
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

  const [menu, setMenu] = React.useState<{ id: string; x: number; y: number } | null>(null)
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [drag, setDrag] = React.useState<DragState | null>(null)

  const onDragStart = (id: string) => (ev: React.DragEvent) => {
    ev.dataTransfer.effectAllowed = "move"
    // Some browsers refuse to fire dragstart without setData.
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
        <WorkspaceTab
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          editingTitle={renamingId === tab.id}
          onActivate={() => setActive(tab.id)}
          onClose={() => close(tab.id)}
          onContextMenu={(ev) => {
            ev.preventDefault()
            setMenu({ id: tab.id, x: ev.clientX, y: ev.clientY })
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
      {menu && (
        <TabContextMenu
          tabId={menu.id}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          actions={{
            close: () => close(menu.id),
            closeOthers: () => closeOthers(menu.id),
            closeToRight: () => closeToRight(menu.id),
            duplicate: () => duplicate(menu.id),
            rename: () => setRenamingId(menu.id),
          }}
        />
      )}
    </div>
  )
}

function TabContextMenu({
  tabId,
  x,
  y,
  onClose,
  actions,
}: {
  tabId: string
  x: number
  y: number
  onClose: () => void
  actions: {
    close: () => void
    closeOthers: () => void
    closeToRight: () => void
    duplicate: () => void
    rename: () => void
  }
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  const W = 200
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024
  const left = Math.min(x, vw - W - 8)
  const top = y

  const Item = ({
    label,
    onClick,
    accel,
    danger,
  }: {
    label: string
    onClick: () => void
    accel?: string
    danger?: boolean
  }) => (
    <button
      type="button"
      onClick={() => {
        onClick()
        onClose()
      }}
      className={cn(
        "w-full flex items-center gap-2 px-2.5 py-1.5 text-sm rounded-sm text-left",
        danger ? "text-destructive hover:bg-destructive/10" : "hover:bg-accent",
      )}
    >
      <span className="flex-1 truncate">{label}</span>
      {accel && <span className="text-xs text-muted-foreground">{accel}</span>}
    </button>
  )

  return (
    <div
      ref={ref}
      data-tab-context-for={tabId}
      style={{ position: "fixed", left, top, width: W, zIndex: 90 }}
      className="bg-popover text-popover-foreground border rounded-md shadow-lg p-1"
    >
      <Item label="关闭" onClick={actions.close} accel="Ctrl+W" />
      <Item label="关闭其他" onClick={actions.closeOthers} />
      <Item label="关闭右侧" onClick={actions.closeToRight} />
      <div className="-mx-1 my-1 h-px bg-border" />
      <Item label="复制 Tab" onClick={actions.duplicate} />
      <Item label="重命名" onClick={actions.rename} accel="双击" />
    </div>
  )
}
