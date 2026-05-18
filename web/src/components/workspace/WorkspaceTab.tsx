"use client"

import * as React from "react"
import { Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WorkspaceTab as WorkspaceTabModel } from "./useWorkspaceStore"
import { metaOf } from "./protocolMeta"

type Props = {
  tab: WorkspaceTabModel
  active: boolean
  draggable?: boolean
  editingTitle?: boolean
  onActivate: () => void
  onClose: () => void
  onContextMenu: (ev: React.MouseEvent) => void
  onDoubleClick: () => void
  onRenameSubmit: (next: string) => void
  onRenameCancel: () => void
  // Drag handlers ride on the tab; the bar owns the drop-target logic.
  onDragStart: (ev: React.DragEvent) => void
  onDragOver: (ev: React.DragEvent) => void
  onDrop: (ev: React.DragEvent) => void
  onDragEnd: () => void
  dragOver?: "left" | "right" | null
}

const STATUS_DOT: Record<WorkspaceTabModel["status"], string> = {
  fresh: "bg-muted-foreground/50",
  connecting: "bg-amber-500 animate-pulse",
  connected: "bg-emerald-500",
  closed: "bg-muted-foreground/50",
  error: "bg-destructive",
}

export function WorkspaceTab({
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
}: Props) {
  const meta = metaOf(tab.protocol)
  const Icon = meta.icon
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
      role="tab"
      aria-selected={active}
      onClick={onActivate}
      onAuxClick={(ev) => {
        // Middle-click closes — standard browser-tab UX.
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
      title={`${tab.title}${tab.host ? ` (${tab.host}${tab.port ? ":" + tab.port : ""})` : ""}`}
      className={cn(
        "group/tab relative flex items-center gap-1.5 h-9 px-2.5 min-w-[140px] max-w-[220px] shrink-0",
        "border-r border-border text-sm cursor-default select-none",
        active
          ? "bg-card text-foreground"
          : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
    >
      {dragOver === "left" && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />}
      {dragOver === "right" && <span className="absolute right-0 top-0 bottom-0 w-0.5 bg-primary" />}
      <Icon className={cn("w-3.5 h-3.5 shrink-0", meta.tint)} />
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[tab.status])} />
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
        <span className="flex-1 min-w-0 truncate">
          {tab.title}
          {tab.status === "connecting" && (
            <Loader2 className="inline w-3 h-3 ml-1 animate-spin text-amber-500" />
          )}
        </span>
      )}
      <button
        type="button"
        tabIndex={-1}
        onClick={(ev) => {
          ev.stopPropagation()
          onClose()
        }}
        className={cn(
          "shrink-0 rounded-sm w-4 h-4 flex items-center justify-center",
          "opacity-0 group-hover/tab:opacity-100 hover:bg-accent",
          active && "opacity-60",
        )}
        title="关闭 (Ctrl+W)"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  )
}
