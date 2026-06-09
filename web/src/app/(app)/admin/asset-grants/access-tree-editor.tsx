"use client"

// 资产目录工作台:选对象 → 搭 TA 专属资产树。@dnd-kit 排序/改父级 + 资产库拖入,
// 右键菜单、多选批量、⌘K 命令面板、从对象/模板复制、子树批量设权、日历有效期、
// 生效预览 + 可视化、改动可撤销。各模块拆在 ./access-tree/*。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable"
import {
  Check,
  ChevronsUpDown,
  Command as CommandIcon,
  FolderPlus,
  GripVertical,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { AppIcon } from "@/components/icons/app-icon"
import { accessTreeService } from "@/lib/api/services"
import type { AccessFolder, Node } from "@/lib/api/types"
import {
  flatten,
  getProjection,
  removeChildrenOf,
  type DragData,
  type Owner,
  type OwnerCat,
} from "./access-tree/tree-model"
import { INDENT, PermPopover, SortableRow, TreeProvider, type TreeCtx } from "./access-tree/sortable-tree"
import { AssetLibrary } from "./access-tree/asset-library"
import { PreviewStrip, InsightDialog } from "./access-tree/insights"
import { CommandPalette, CopyMenu } from "./access-tree/dialogs"

export type { OwnerCat } from "./access-tree/tree-model"

export function AccessTreeTab({ cats, nodes }: { cats: OwnerCat[]; nodes: Node[] }) {
  const ownerCats = React.useMemo(() => cats.filter((c) => c.key !== "role"), [cats])
  const [owner, setOwner] = React.useState<Owner | null>(null)
  return (
    <div className="space-y-3">
      <OwnerPicker cats={ownerCats} value={owner} onChange={setOwner} />
      {!owner ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-12 text-center">
          <AppIcon icon="lucide:folder-tree" size={28} className="text-muted-foreground/60" />
          <p className="text-sm font-medium">选一个对象，开始搭建资产树</p>
          <p className="max-w-sm text-xs text-muted-foreground">用户 / 用户组 / 部门都行，组和部门的树会被成员继承。</p>
        </div>
      ) : (
        <OwnerTreeEditor key={`${owner.type}:${owner.id}`} owner={owner} ownerCats={ownerCats} nodes={nodes} />
      )}
    </div>
  )
}

function OwnerAvatar({ cat, size = 22 }: { cat?: OwnerCat; size?: number }) {
  const Icon = cat?.icon
  return (
    <span className="grid shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" style={{ width: size, height: size }}>
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
    </span>
  )
}

function OwnerPicker({ cats, value, onChange }: { cats: OwnerCat[]; value: Owner | null; onChange: (v: Owner) => void }) {
  const [open, setOpen] = React.useState(false)
  const cur = value ? cats.find((c) => c.key === value.type) : undefined
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="h-11 w-full max-w-md justify-start gap-2 px-2.5">
          <OwnerAvatar cat={cur} />
          {value ? (
            <span className="min-w-0 text-left">
              <span className="block truncate text-sm font-medium leading-tight">{value.name}</span>
              <span className="block text-[11px] leading-tight text-muted-foreground">{cur?.label}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">选一个用户 / 用户组 / 部门</span>
          )}
          <ChevronsUpDown className="ml-auto h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索用户 / 组 / 部门…" />
          <CommandList>
            <CommandEmpty>没有匹配项</CommandEmpty>
            {cats.map((c) => (
              <CommandGroup key={c.key} heading={c.label}>
                {c.items.map((i) => (
                  <CommandItem key={`${c.key}:${i.id}`} value={`${c.label} ${i.name} ${i.sub ?? ""}`} onSelect={() => { onChange({ type: c.key, id: i.id, name: i.name }); setOpen(false) }} className="gap-2">
                    <OwnerAvatar cat={c} size={20} />
                    <span className="flex-1 truncate">{i.name}</span>
                    {value?.type === c.key && value?.id === i.id ? <Check className="h-4 w-4" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function OwnerTreeEditor({ owner, ownerCats, nodes }: { owner: Owner; ownerCats: OwnerCat[]; nodes: Node[] }) {
  const qc = useQueryClient()
  const cur = ownerCats.find((c) => c.key === owner.type)
  const nodeById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const detail = useQuery({ queryKey: ["access-tree", owner.type, owner.id], queryFn: () => accessTreeService.get(owner.type, owner.id) })
  const folders = detail.data?.folders ?? []
  const items = detail.data?.items ?? []
  const placed = React.useMemo(() => new Set(items.map((i) => i.node_id)), [items])

  const [collapsed, setCollapsed] = React.useState<Set<number>>(new Set())
  const [target, setTarget] = React.useState<number | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [editing, setEditing] = React.useState<number | null>(null)
  const [editName, setEditName] = React.useState("")
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [activeDrag, setActiveDrag] = React.useState<DragData | null>(null)
  const [overId, setOverId] = React.useState<string | null>(null)
  const [offsetLeft, setOffsetLeft] = React.useState(0)
  const [insightOpen, setInsightOpen] = React.useState(false)
  const [cmdkOpen, setCmdkOpen] = React.useState(false)
  const [undo, setUndo] = React.useState<{ label: string; fn: () => void } | null>(null)
  const lastSel = React.useRef<number | null>(null)

  React.useEffect(() => {
    if (target != null && !folders.some((f) => f.id === target)) setTarget(null)
    if (target == null && folders.length > 0) setTarget(folders[0].id)
  }, [folders, target])

  // ⌘K
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setCmdkOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [])

  const rowsBase = React.useMemo(() => flatten(folders, items, nodeById, collapsed), [folders, items, nodeById, collapsed])
  const displayRows = React.useMemo(
    () => (activeId && activeId.startsWith("folder:") ? removeChildrenOf(rowsBase, [activeId]) : rowsBase),
    [rowsBase, activeId],
  )
  const proj = React.useMemo(
    () => (activeId && overId && !activeId.startsWith("lib:") ? getProjection(displayRows, activeId, overId, offsetLeft, INDENT) : null),
    [displayRows, activeId, overId, offsetLeft],
  )

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["access-tree", owner.type, owner.id] })
    void qc.invalidateQueries({ queryKey: ["access"] })
  }
  const onErr = (e: Error) => toast.error("操作失败", { description: e.message })
  const mut = <T,>(fn: (v: T) => Promise<unknown>, opts?: { onSuccess?: () => void }) =>
    useMutation({ mutationFn: fn, onSuccess: () => { refresh(); opts?.onSuccess?.() }, onError: onErr })

  const mCreate = useMutation({
    mutationFn: (parent_id: number | null) => accessTreeService.createFolder({ owner_type: owner.type, owner_id: owner.id, name: "新建文件夹", parent_id }),
    onSuccess: (f) => { refresh(); setEditing(f.id); setEditName(f.name); setTarget(f.id) },
    onError: onErr,
  })
  const mRename = mut((v: { id: number; name: string }) => accessTreeService.updateFolder(v.id, { name: v.name }), { onSuccess: () => setEditing(null) })
  const mFolderIcon = mut((v: { id: number; icon: string }) => accessTreeService.updateFolder(v.id, { icon: v.icon }))
  const mDeleteFolder = mut((id: number) => accessTreeService.removeFolder(id))
  const mMoveFolder = useMutation({ mutationFn: (v: { id: number; parent: number | null }) => accessTreeService.moveFolder(v.id, v.parent), onSuccess: refresh, onError: onErr })
  const mMoveItem = useMutation({ mutationFn: (v: { id: number; folder_id: number }) => accessTreeService.updateItem(v.id, { folder_id: v.folder_id }), onSuccess: refresh, onError: onErr })
  const mRemoveItem = mut((id: number) => accessTreeService.removeItem(id))
  const mAddItems = useMutation({
    mutationFn: (v: { folder_id: number; node_ids: number[] }) => accessTreeService.addItems({ owner_type: owner.type, owner_id: owner.id, folder_id: v.folder_id, node_ids: v.node_ids }),
    onSuccess: (r) => { refresh(); toast.success(`已加入 ${r.added} 个资产`) },
    onError: onErr,
  })
  const mReorder = useMutation({ mutationFn: (v: { kind: "folder" | "item"; ids: number[] }) => accessTreeService.reorder(v.kind, v.ids), onSuccess: refresh, onError: onErr })
  const mSetFolderPerm = mut((v: { id: number; actions: string; valid_to: string }) => accessTreeService.updateFolder(v.id, { actions: v.actions, valid_to: v.valid_to }))
  const mSetItemPerm = mut((v: { id: number; actions: string; valid_to: string }) => accessTreeService.updateItem(v.id, { actions: v.actions, valid_to: v.valid_to }))
  const mApplySubtree = mut((v: { id: number; actions: string; valid_to: string }) => accessTreeService.applySubtree(v.id, { actions: v.actions, valid_to: v.valid_to }))

  const ctx: TreeCtx = {
    target,
    setTarget,
    toggle: (fid) => setCollapsed((p) => { const n = new Set(p); n.has(fid) ? n.delete(fid) : n.add(fid); return n }),
    selected,
    toggleSelect: (rowId, shift) => {
      setSelected((p) => {
        const n = new Set(p)
        const idx = displayRows.findIndex((r) => r.id === rowId)
        if (shift && lastSel.current != null) {
          const [a, b] = [lastSel.current, idx].sort((x, y) => x - y)
          for (let i = a; i <= b; i++) n.add(displayRows[i].id)
        } else n.has(rowId) ? n.delete(rowId) : n.add(rowId)
        return n
      })
      lastSel.current = displayRows.findIndex((r) => r.id === rowId)
    },
    editing,
    editName,
    setEditName,
    startEdit: (f) => { setEditing(f.id); setEditName(f.name) },
    saveEdit: (fid) => (editName.trim() ? mRename.mutate({ id: fid, name: editName.trim() }) : setEditing(null)),
    cancelEdit: () => setEditing(null),
    folderIcon: (fid, icon) => mFolderIcon.mutate({ id: fid, icon }),
    setPerm: (kind, id, actions, valid_to) => (kind === "folder" ? mSetFolderPerm : mSetItemPerm).mutate({ id, actions, valid_to }),
    applySubtree: (id, actions, valid_to) => mApplySubtree.mutate({ id, actions, valid_to }),
    newSub: (parent) => mCreate.mutate(parent),
    deleteFolder: (f) => { if (confirm(`删除文件夹「${f.name}」？其子文件夹与资产都会一并移除。`)) mDeleteFolder.mutate(f.id) },
    removeItem: (id) => {
      const it = items.find((x) => x.id === id)
      mRemoveItem.mutate(id)
      if (it) setUndo({ label: "移除资产", fn: () => mAddItems.mutate({ folder_id: it.folder_id, node_ids: [it.node_id] }) })
    },
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const resetDrag = () => { setActiveId(null); setActiveDrag(null); setOverId(null); setOffsetLeft(0) }
  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current as DragData | undefined
    setActiveDrag(d ?? null)
    setActiveId(String(e.active.id))
    setOverId(String(e.active.id))
  }
  const onDragMove = (e: DragMoveEvent) => setOffsetLeft(e.delta.x)
  const onDragOver = (e: DragOverEvent) => setOverId(e.over ? String(e.over.id) : null)
  const onDragEnd = (e: DragEndEvent) => {
    const a = e.active.data.current as DragData | undefined
    const overRowId = e.over ? String(e.over.id) : null
    const off = offsetLeft
    resetDrag()
    if (!a || !overRowId) return

    if (a.kind === "lib") {
      const overRow = rowsBase.find((r) => r.id === overRowId)
      const folderId = overRow?.kind === "folder" ? overRow.fid! : overRow?.item ? overRow.item.folder_id : null
      if (folderId) mAddItems.mutate({ folder_id: folderId, node_ids: [a.nodeId] })
      return
    }
    // sorted tree row
    const cloned = removeChildrenOf(rowsBase, [a.rowId])
    const overIndex = cloned.findIndex((r) => r.id === overRowId)
    const activeIndex = cloned.findIndex((r) => r.id === a.rowId)
    if (overIndex < 0 || activeIndex < 0) return
    const projection = getProjection(cloned, a.rowId, overRowId, off, INDENT)
    if (!projection) return
    const newRows = arrayMove(cloned, activeIndex, overIndex).map((r, i) => (i === overIndex ? { ...r, parentId: projection.parentId, depth: projection.depth } : r))
    const activeRow = cloned[activeIndex]
    const newParentFid = projection.parentId ? Number(projection.parentId.slice("folder:".length)) : null

    if (activeRow.kind === "folder") {
      const fid = activeRow.fid!
      const oldParent = activeRow.parentId ? Number(activeRow.parentId.slice("folder:".length)) : null
      const siblings = newRows.filter((r) => r.parentId === projection.parentId && r.kind === "folder").map((r) => r.fid!)
      if (newParentFid !== oldParent) mMoveFolder.mutate({ id: fid, parent: newParentFid }, { onSuccess: () => mReorder.mutate({ kind: "folder", ids: siblings }) })
      else if (siblings.length > 1) mReorder.mutate({ kind: "folder", ids: siblings })
    } else {
      const it = activeRow.item!
      if (!newParentFid) return
      const siblings = newRows.filter((r) => r.parentId === projection.parentId && r.kind === "item").map((r) => r.item!.id)
      if (newParentFid !== it.folder_id) {
        const old = it.folder_id
        mMoveItem.mutate({ id: it.id, folder_id: newParentFid }, { onSuccess: () => mReorder.mutate({ kind: "item", ids: siblings }) })
        setUndo({ label: "移动资产", fn: () => mMoveItem.mutate({ id: it.id, folder_id: old }) })
      } else if (siblings.length > 1) mReorder.mutate({ kind: "item", ids: siblings })
    }
  }

  const selectedItemIds = [...selected].filter((id) => id.startsWith("item:")).map((id) => Number(id.slice(5)))
  const batchRemove = () => {
    selectedItemIds.forEach((id) => mRemoveItem.mutate(id))
    setSelected(new Set())
  }
  const batchPerm = (actions: string, valid_to: string) => {
    selectedItemIds.forEach((id) => mSetItemPerm.mutate({ id, actions, valid_to }))
    setSelected(new Set())
  }
  const targetName = target != null ? folders.find((f) => f.id === target)?.name : undefined

  return (
    <TreeProvider value={ctx}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragMove={onDragMove} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={resetDrag}>
        <div className="flex h-[calc(100vh-13rem)] flex-col overflow-hidden rounded-xl border">
          {/* toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
            <OwnerAvatar cat={cur} />
            <span className="min-w-0 truncate text-sm font-medium">{owner.name}</span>
            <span className="text-xs text-muted-foreground">的资产树</span>
            <div className="ml-auto flex items-center gap-2">
              {undo ? (
                <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => { undo.fn(); setUndo(null) }}>
                  <RotateCcw className="h-3.5 w-3.5" /> 撤销{undo.label}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => setCmdkOpen(true)}>
                <CommandIcon className="h-3.5 w-3.5" /> ⌘K
              </Button>
              <CopyMenu owner={owner} ownerCats={ownerCats} onDone={refresh} />
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => mCreate.mutate(null)}>
                <FolderPlus className="h-3.5 w-3.5" /> 新建文件夹
              </Button>
            </div>
          </div>

          {/* batch bar */}
          {selectedItemIds.length > 0 ? (
            <div className="flex shrink-0 items-center gap-2 border-b bg-primary/[0.04] px-3 py-1.5 text-sm">
              <span className="font-medium">已选 {selectedItemIds.length} 个资产</span>
              <div className="ml-auto flex items-center gap-1.5">
                <PermPopover onApply={batchPerm} />
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-destructive hover:text-destructive" onClick={batchRemove}>
                  <Trash2 className="h-3.5 w-3.5" /> 批量移除
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelected(new Set())}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_320px]">
            {/* tree */}
            <div className="flex min-h-0 flex-col border-r">
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {detail.isLoading ? (
                  <div className="px-2 py-10 text-center text-xs text-muted-foreground">加载中…</div>
                ) : displayRows.length === 0 ? (
                  <button type="button" onClick={() => mCreate.mutate(null)} className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed px-3 py-10 text-center text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
                    <Plus className="h-5 w-5" />
                    <span className="text-sm font-medium">新建第一个文件夹</span>
                    <span className="text-xs">再把右侧资产拖进来，或按 ⌘K 快速添加</span>
                  </button>
                ) : (
                  <SortableContext items={displayRows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-0.5">
                      {displayRows.map((r) => (
                        <SortableRow key={r.id} row={r} projected={proj} activeId={activeId} />
                      ))}
                    </div>
                  </SortableContext>
                )}
              </div>
              <PreviewStrip folders={folders} items={items} ownerType={owner.type} onOpenInsight={() => setInsightOpen(true)} />
            </div>

            {/* library */}
            <AssetLibrary
              nodes={nodes}
              placed={placed}
              target={target}
              targetName={targetName}
              onAdd={(ids) => { if (target == null) { toast.error("先在左侧选择一个目标文件夹"); return } mAddItems.mutate({ folder_id: target, node_ids: ids }) }}
            />
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {activeDrag ? (
            <div className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-sm shadow-lg">
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="max-w-[200px] truncate">{activeDrag.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <InsightDialog open={insightOpen} onOpenChange={setInsightOpen} folders={folders} items={items} nodeById={nodeById} ownerName={owner.name} />
      <CommandPalette
        open={cmdkOpen}
        onOpenChange={setCmdkOpen}
        nodes={nodes}
        folders={folders.map((f: AccessFolder) => ({ id: f.id, name: f.name }))}
        targetName={targetName}
        onAddToTarget={(nodeId) => { if (target != null) mAddItems.mutate({ folder_id: target, node_ids: [nodeId] }) }}
        onJumpFolder={(id) => { setTarget(id); setCollapsed((p) => { const n = new Set(p); n.delete(id); return n }) }}
      />
    </TreeProvider>
  )
}
