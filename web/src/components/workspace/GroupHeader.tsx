"use client"

// GroupHeader — the strip element that sits to the left of every group of
// tabs. Shows a color swatch + label + count, lets the user collapse the
// group (which hides its tabs from the strip), and exposes color / rename
// actions through a ContextMenu so the user can adjust without leaving
// the workspace.

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { ChevronDown, ChevronRight } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { useWorkspaceStore, type GroupColor, type TabGroup } from "./useWorkspaceStore"
import { GROUP_COLOR_NAME, GROUP_PILL_BG, GROUP_SWATCH_BG } from "./groupColors"

const ALL_COLORS: GroupColor[] = [
  "blue", "green", "purple", "orange", "red", "cyan", "yellow", "gray",
]

interface Props {
  group: TabGroup
  count: number
  // Manual groups support edit / delete; derived groups (by-node/protocol)
  // are read-only so we suppress the corresponding ContextMenu items.
  readOnly?: boolean
}

export function GroupHeader({ group, count, readOnly = false }: Props) {
  const toggleCollapsed = useWorkspaceStore((s) => s.toggleGroupCollapsed)
  const renameGroup = useWorkspaceStore((s) => s.renameGroup)
  const recolorGroup = useWorkspaceStore((s) => s.recolorGroup)
  const deleteGroup = useWorkspaceStore((s) => s.deleteGroup)
  const moveTabToGroup = useWorkspaceStore((s) => s.moveTabToGroup)
  const reduced = useReducedMotion()

  const [editing, setEditing] = React.useState(false)
  const [dropActive, setDropActive] = React.useState(false)
  const [draft, setDraft] = React.useState(group.name)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!editing) return
    setDraft(group.name)
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [editing, group.name])

  const commit = React.useCallback(() => {
    setEditing(false)
    const v = draft.trim()
    if (v && v !== group.name) renameGroup(group.id, v)
  }, [draft, group.id, group.name, renameGroup])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.div
          layout={!reduced}
          initial={reduced ? false : { opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced ? undefined : { opacity: 0, x: -6 }}
          transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
          className={cn(
            "group/group flex items-center gap-1 h-9 px-2 shrink-0 select-none",
            "border-r border-border/60 cursor-default",
            "text-xs font-medium",
            GROUP_PILL_BG[group.color],
            dropActive && "ring-2 ring-inset ring-primary/50",
          )}
          onDoubleClick={() => !readOnly && setEditing(true)}
          onDragOver={
            readOnly
              ? undefined
              : (e) => {
                  e.preventDefault()
                  if (!dropActive) setDropActive(true)
                }
          }
          onDragLeave={readOnly ? undefined : () => setDropActive(false)}
          onDrop={
            readOnly
              ? undefined
              : (e) => {
                  e.preventDefault()
                  setDropActive(false)
                  // Tab strip sets text/plain to the dragged tab id.
                  const id = e.dataTransfer.getData("text/plain")
                  if (id) moveTabToGroup(id, group.id)
                }
          }
          title={readOnly ? `${group.name} · 自动分组` : `${group.name} · 双击改名`}
        >
          <button
            type="button"
            onClick={() => toggleCollapsed(group.id)}
            className="inline-flex items-center justify-center rounded-sm w-4 h-4 hover:bg-black/10 dark:hover:bg-white/10"
            aria-label={group.collapsed ? "展开" : "折叠"}
          >
            {group.collapsed ? (
              <ChevronRight className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
          </button>
          <span className={cn("inline-block w-2 h-2 rounded-full", GROUP_SWATCH_BG[group.color])} />
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commit()
                }
                if (e.key === "Escape") {
                  e.preventDefault()
                  setEditing(false)
                }
                e.stopPropagation()
              }}
              onBlur={commit}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 bg-transparent outline-none border-b border-current px-0.5 text-xs w-24"
              spellCheck={false}
            />
          ) : (
            <span className="truncate max-w-[160px]">{group.name}</span>
          )}
          <span className="ml-1 text-[10px] opacity-70 tabular-nums">{count}</span>
        </motion.div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => toggleCollapsed(group.id)}>
          {group.collapsed ? "展开分组" : "折叠分组"}
        </ContextMenuItem>
        {!readOnly && (
          <>
            <ContextMenuItem onSelect={() => setEditing(true)}>重命名</ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>更换颜色</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {ALL_COLORS.map((color) => (
                  <ContextMenuItem
                    key={color}
                    onSelect={() => recolorGroup(group.id, color)}
                  >
                    <span className={cn("inline-block w-3 h-3 rounded-full mr-2", GROUP_SWATCH_BG[color])} />
                    {GROUP_COLOR_NAME[color]}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => deleteGroup(group.id)}
              className="text-destructive focus:text-destructive"
            >
              删除分组
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
