"use client"

// 可排序树行:@dnd-kit/sortable(同级拖动排序 + 横向拖动改父级,投影由编辑器算)、
// 右键菜单、多选复选框、行内权限弹窗(shadcn Calendar 真日历)。DndContext 在编辑器里。

import * as React from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core"
import { Check, ChevronRight, Clock, FolderPlus, Layers, Pencil, Settings2, Trash2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { AppIcon } from "@/components/icons/app-icon"
import { IconPicker } from "@/components/icons/icon-picker"
import { nodeIcon } from "@/lib/icons/protocol"
import { PRESETS, actionLabel } from "@/lib/access/permissions"
import type { AccessFolder, AccessItem } from "@/lib/api/types"
import type { DragData, FlatRow, Projection } from "./tree-model"

export const INDENT = 18

export interface TreeCtx {
  target: number | null
  setTarget: (n: number) => void
  toggle: (fid: number) => void
  selected: Set<string>
  toggleSelect: (rowId: string, shift: boolean) => void
  editing: number | null
  editName: string
  setEditName: (v: string) => void
  startEdit: (f: AccessFolder) => void
  saveEdit: (fid: number) => void
  cancelEdit: () => void
  folderIcon: (fid: number, icon: string) => void
  setPerm: (kind: "folder" | "item", id: number, actions: string, valid_to: string) => void
  applySubtree: (fid: number, actions: string, valid_to: string) => void
  newSub: (parent: number) => void
  deleteFolder: (f: AccessFolder) => void
  removeItem: (id: number) => void
}
const Ctx = React.createContext<TreeCtx | null>(null)
export const TreeProvider = Ctx.Provider
export const useTree = () => React.useContext(Ctx)!

export function SortableRow({ row, projected, activeId }: { row: FlatRow; projected: Projection | null; activeId: string | null }) {
  const label = row.kind === "folder" ? row.folder!.name : row.node?.name ?? `#${row.item?.node_id}`
  const s = useSortable({ id: row.id, data: { kind: "row", rowId: row.id, rowKind: row.kind, label } satisfies DragData })
  const isActive = activeId === row.id
  const depth = isActive && projected ? projected.depth : row.depth
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(s.transform),
    transition: s.transition,
    paddingLeft: depth * INDENT,
  }
  return (
    <div ref={s.setNodeRef} style={style} className={cn(s.isDragging && "opacity-50")}>
      {row.kind === "folder" ? (
        <FolderRow row={row} dragRef={s.setActivatorNodeRef} listeners={s.listeners} attributes={s.attributes} over={s.isOver} />
      ) : (
        <ItemRow row={row} dragRef={s.setActivatorNodeRef} listeners={s.listeners} attributes={s.attributes} />
      )}
    </div>
  )
}

type DragProps = {
  dragRef: (el: HTMLElement | null) => void
  listeners?: DraggableSyntheticListeners
  attributes?: DraggableAttributes
}

function FolderRow({ row, dragRef, listeners, attributes, over }: { row: FlatRow; over: boolean } & DragProps) {
  const t = useTree()
  const f = row.folder!
  const editing = t.editing === f.id
  const selected = t.selected.has(row.id)

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 pr-1">
        <IconPicker value={f.icon} onChange={(icon) => t.folderIcon(f.id, icon)} />
        <Input
          autoFocus
          value={t.editName}
          onChange={(e) => t.setEditName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") t.saveEdit(f.id)
            if (e.key === "Escape") t.cancelEdit()
          }}
          className="h-7 flex-1 text-sm"
        />
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => t.saveEdit(f.id)}>
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={t.cancelEdit}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragRef}
          {...listeners}
          {...attributes}
          onClick={() => t.setTarget(f.id)}
          className={cn(
            "group/row flex cursor-grab items-center gap-1 rounded-md py-1 pr-1 text-sm active:cursor-grabbing",
            over ? "bg-primary/[0.08] ring-2 ring-inset ring-primary/40" : selected ? "bg-primary/[0.06]" : t.target === f.id ? "bg-primary/[0.06] ring-1 ring-inset ring-primary/25" : "hover:bg-muted/60",
          )}
        >
          <SelectBox rowId={row.id} />
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              if (row.hasChildren) t.toggle(f.id)
            }}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground/70 hover:text-foreground"
          >
            {row.hasChildren ? <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", !row.collapsed && "rotate-90")} /> : null}
          </button>
          <AppIcon icon={f.icon} fallback="lucide:folder" size={15} className="shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate font-medium">{f.name}</span>
          <PermBadge actions={f.actions} validTo={f.valid_to} />
          <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
            <PermPopover actions={f.actions} validTo={f.valid_to} showSubtree onApply={(a, v) => t.setPerm("folder", f.id, a, v)} onApplySubtree={(a, v) => t.applySubtree(f.id, a, v)} />
            <RowBtn title="新建子文件夹" onClick={() => t.newSub(f.id)}><FolderPlus className="h-3.5 w-3.5" /></RowBtn>
            <RowBtn title="重命名" onClick={() => t.startEdit(f)}><Pencil className="h-3.5 w-3.5" /></RowBtn>
            <RowBtn title="删除" danger onClick={() => t.deleteFolder(f)}><Trash2 className="h-3.5 w-3.5" /></RowBtn>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => t.newSub(f.id)}><FolderPlus className="h-4 w-4" /> 新建子文件夹</ContextMenuItem>
        <ContextMenuItem onClick={() => t.startEdit(f)}><Pencil className="h-4 w-4" /> 重命名</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => t.applySubtree(f.id, f.actions ?? "", f.valid_to ? String(f.valid_to) : "")}>
          <Layers className="h-4 w-4" /> 把本文件夹权限套到整棵子树
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => t.deleteFolder(f)}><Trash2 className="h-4 w-4" /> 删除</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ItemRow({ row, dragRef, listeners, attributes }: { row: FlatRow } & DragProps) {
  const t = useTree()
  const it = row.item as AccessItem
  const n = row.node
  const selected = t.selected.has(row.id)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={dragRef}
          {...listeners}
          {...attributes}
          className={cn(
            "group/row flex cursor-grab items-center gap-1.5 rounded-md py-1 pr-1 pl-5 text-sm active:cursor-grabbing",
            selected ? "bg-primary/[0.06]" : "hover:bg-muted/50",
          )}
        >
          <SelectBox rowId={row.id} />
          <AppIcon icon={n ? nodeIcon(n) : "lucide:server"} size={14} className="shrink-0" />
          <span className="flex-1 truncate">{n ? n.name : `#${it.node_id}（已删除）`}</span>
          <PermBadge actions={it.actions} validTo={it.valid_to} />
          {n ? <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{n.host}</span> : null}
          <span className="flex shrink-0 items-center gap-0.5">
            <PermPopover actions={it.actions} validTo={it.valid_to} onApply={(a, v) => t.setPerm("item", it.id, a, v)} />
            <RowBtn title="移除" danger onClick={() => t.removeItem(it.id)}><X className="h-3.5 w-3.5" /></RowBtn>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={() => t.removeItem(it.id)}><Trash2 className="h-4 w-4" /> 移除</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function SelectBox({ rowId }: { rowId: string }) {
  const t = useTree()
  return (
    <span
      className={cn("grid h-4 w-4 shrink-0 place-items-center transition-opacity", t.selected.has(rowId) ? "opacity-100" : "opacity-0 group-hover/row:opacity-100")}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Checkbox className="h-3.5 w-3.5" checked={t.selected.has(rowId)} onClick={(e) => t.toggleSelect(rowId, (e as React.MouseEvent).shiftKey)} />
    </span>
  )
}

function RowBtn({ children, title, onClick, danger }: { children: React.ReactNode; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn("grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-foreground/10", danger ? "hover:text-destructive" : "hover:text-foreground")}
    >
      {children}
    </button>
  )
}

export function PermBadge({ actions, validTo }: { actions?: string; validTo?: string | null }) {
  const codes = (actions ?? "").split(",").filter(Boolean)
  if (codes.length === 0 && !validTo) return null
  const label = codes.length ? PRESETS.find((p) => p.actions.slice().sort().join(",") === codes.slice().sort().join(","))?.label ?? codes.map(actionLabel).join(" · ") : null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {label ? <Badge variant="secondary" className="font-normal text-[10px]">{label}</Badge> : null}
      {validTo ? <Clock className="h-3 w-3 text-warning" /> : null}
    </span>
  )
}

// ---- inline permission editor (presets + 日历有效期) ----

type ValidMode = "inherit" | "7d" | "30d" | "90d" | "custom"

export function PermPopover({
  actions,
  validTo,
  showSubtree,
  onApply,
  onApplySubtree,
}: {
  actions?: string
  validTo?: string | null
  showSubtree?: boolean
  onApply: (actions: string, valid_to: string) => void
  onApplySubtree?: (actions: string, valid_to: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [presetKey, setPresetKey] = React.useState("inherit")
  const [mode, setMode] = React.useState<ValidMode>("inherit")
  const [date, setDate] = React.useState<Date | undefined>(undefined)

  React.useEffect(() => {
    if (!open) return
    const codes = (actions ?? "").split(",").filter(Boolean)
    setPresetKey(codes.length === 0 ? "inherit" : PRESETS.find((x) => x.actions.slice().sort().join(",") === codes.slice().sort().join(","))?.key ?? "full")
    setMode(validTo ? "custom" : "inherit")
    setDate(validTo ? new Date(validTo) : undefined)
  }, [open, actions, validTo])

  const compute = (): { acts: string; to: string } => {
    const acts = presetKey === "inherit" ? "" : PRESETS.find((p) => p.key === presetKey)?.actions.join(",") ?? ""
    let to = ""
    if (mode === "custom") to = date ? date.toISOString() : ""
    else if (mode !== "inherit") {
      const days = mode === "7d" ? 7 : mode === "30d" ? 30 : 90
      const d = new Date()
      d.setDate(d.getDate() + days)
      to = d.toISOString()
    }
    return { acts, to }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="权限 / 有效期"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3" align="end" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">权限</Label>
          <div className="flex flex-wrap gap-1.5">
            <Chip on={presetKey === "inherit"} onClick={() => setPresetKey("inherit")}>继承</Chip>
            {PRESETS.map((p) => (
              <Chip key={p.key} on={presetKey === p.key} onClick={() => setPresetKey(p.key)} title={p.desc}>{p.label}</Chip>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">有效期</Label>
          <div className="flex flex-wrap gap-1.5">
            {(["inherit", "7d", "30d", "90d", "custom"] as ValidMode[]).map((m) => (
              <Chip key={m} on={mode === m} onClick={() => setMode(m)}>
                {m === "inherit" ? "继承" : m === "custom" ? "选日期" : m === "7d" ? "7 天" : m === "30d" ? "30 天" : "90 天"}
              </Chip>
            ))}
          </div>
          {mode === "custom" ? (
            <div className="rounded-md border">
              <Calendar mode="single" selected={date} onSelect={setDate} disabled={{ before: new Date() }} />
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          {showSubtree && onApplySubtree ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const { acts, to } = compute()
                onApplySubtree(acts, to)
                setOpen(false)
              }}
            >
              应用到子树
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => {
              const { acts, to } = compute()
              onApply(acts, to)
              setOpen(false)
            }}
          >
            应用
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Chip({ children, on, onClick, title }: { children: React.ReactNode; on: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn("rounded-md border px-2 py-1 text-xs transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent")}
    >
      {children}
    </button>
  )
}
