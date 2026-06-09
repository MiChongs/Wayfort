"use client"

// 资产目录（按对象）：选一个用户 / 用户组 / 部门 → 直接搭建 TA 专属的多级资产树。
// 把资产放进文件夹就等于授权；权限/有效期可在文件夹或单个资产上行内设置（子级
// 继承父文件夹、可覆盖）。组/部门的树被成员继承。树即授权，无单独分配步骤。
//
// 拖拽全部基于 @dnd-kit/core（统一 DndContext）：
//   · 从右侧资产库把资产拖进文件夹           （新增放置）
//   · 把已放置的资产在文件夹之间拖动           （改归属，保留权限覆盖）
//   · 把文件夹拖到另一个文件夹 / 顶层条        （改层级）
// PointerSensor 6px 阈值 → 行内点击/双击仍正常；拖动用 DragOverlay 呈现。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  CornerLeftUp,
  FolderPlus,
  GripVertical,
  Pencil,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AppIcon } from "@/components/icons/app-icon"
import { IconPicker } from "@/components/icons/icon-picker"
import { accessTreeService } from "@/lib/api/services"
import type { AccessFolder, AccessItem, GranteeKind, Node } from "@/lib/api/types"
import { PRESETS, actionLabel } from "@/lib/access/permissions"

export interface OwnerCat {
  key: GranteeKind
  label: string
  icon?: React.ComponentType<{ className?: string }>
  items: { id: number; name: string; sub?: string }[]
}
type Owner = { type: GranteeKind; id: number; name: string }

export function AccessTreeTab({ cats, nodes }: { cats: OwnerCat[]; nodes: Node[] }) {
  // Tree ownership is limited to user / group / department (roles are flat-grant).
  const ownerCats = React.useMemo(() => cats.filter((c) => c.key !== "role"), [cats])
  const [owner, setOwner] = React.useState<Owner | null>(null)

  return (
    <div className="space-y-3">
      <OwnerPicker cats={ownerCats} value={owner} onChange={setOwner} />
      {!owner ? (
        <div className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">
          选一个用户 / 用户组 / 部门，直接搭建 TA 专属的资产树。放进去就等于授权；组 / 部门的树会被成员继承。
        </div>
      ) : (
        <OwnerTreeEditor key={`${owner.type}:${owner.id}`} owner={owner} nodes={nodes} />
      )}
    </div>
  )
}

// ---- owner picker (跨类目搜索的单选) ----

function OwnerPicker({
  cats,
  value,
  onChange,
}: {
  cats: OwnerCat[]
  value: Owner | null
  onChange: (v: Owner) => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full max-w-md justify-between">
          {value ? value.name : <span className="text-muted-foreground">选一个用户 / 用户组 / 部门</span>}
          <ChevronsUpDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索…" />
          <CommandList>
            <CommandEmpty>没有匹配项</CommandEmpty>
            {cats.map((c) => (
              <CommandGroup key={c.key} heading={c.label}>
                {c.items.map((i) => (
                  <CommandItem
                    key={`${c.key}:${i.id}`}
                    value={`${c.label} ${i.name} ${i.sub ?? ""}`}
                    onSelect={() => {
                      onChange({ type: c.key, id: i.id, name: i.name })
                      setOpen(false)
                    }}
                  >
                    <Check className={cn("mr-2 h-4 w-4", value?.type === c.key && value?.id === i.id ? "opacity-100" : "opacity-0")} />
                    <span className="flex-1">{i.name}</span>
                    {i.sub ? <span className="text-xs text-muted-foreground">{i.sub}</span> : null}
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

// ---- tree model ----

type DirItem =
  | { type: "folder"; fid: number; folder: AccessFolder; children: DirItem[] }
  | { type: "asset"; item: AccessItem; node?: Node }

function buildTree(folders: AccessFolder[], items: AccessItem[], nodeById: Map<number, Node>): DirItem[] {
  const folderIds = new Set(folders.map((f) => f.id))
  const childrenOf = new Map<number, AccessFolder[]>()
  for (const f of folders) {
    const key = f.parent_id != null && folderIds.has(f.parent_id) ? f.parent_id : 0
    const arr = childrenOf.get(key) ?? []
    arr.push(f)
    childrenOf.set(key, arr)
  }
  const itemsByFolder = new Map<number, AccessItem[]>()
  for (const it of items) {
    const arr = itemsByFolder.get(it.folder_id) ?? []
    arr.push(it)
    itemsByFolder.set(it.folder_id, arr)
  }
  const makeFolder = (f: AccessFolder): DirItem => {
    const childFolders = (childrenOf.get(f.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(makeFolder)
    const assets: DirItem[] = (itemsByFolder.get(f.id) ?? []).map((it) => ({ type: "asset", item: it, node: nodeById.get(it.node_id) }))
    return { type: "folder", fid: f.id, folder: f, children: [...childFolders, ...assets] }
  }
  return (childrenOf.get(0) ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(makeFolder)
}

// ids of all folders that are descendants of fid (incl. self) — client-side
// cycle guard so we don't even attempt an illegal folder move.
function subtreeFolderIds(folders: AccessFolder[], fid: number): Set<number> {
  const self = folders.find((f) => f.id === fid)
  const out = new Set<number>([fid])
  if (!self) return out
  const prefix = self.path
  for (const f of folders) {
    if (f.path === prefix || f.path.startsWith(prefix + "/")) out.add(f.id)
  }
  return out
}

// ---- editor context (so deep rows reach the handlers without prop drilling) ----

interface EditorCtx {
  target: number | null
  setTarget: (n: number) => void
  collapsed: Set<number>
  toggle: (fid: number) => void
  editing: number | null
  editName: string
  setEditName: (v: string) => void
  startEdit: (f: AccessFolder) => void
  saveEdit: (fid: number) => void
  cancelEdit: () => void
  folderIcon: (fid: number, icon: string) => void
  folderPerm: (fid: number, actions: string, valid_to: string) => void
  newSub: (parent: number) => void
  deleteFolder: (f: AccessFolder) => void
  itemPerm: (id: number, actions: string, valid_to: string) => void
  removeItem: (id: number) => void
}
const Ctx = React.createContext<EditorCtx | null>(null)
const useEditor = () => React.useContext(Ctx)!

// ---- per-owner tree editor ----

type DragData =
  | { kind: "lib"; nodeId: number; label: string }
  | { kind: "item"; itemId: number; fromFolder: number; label: string }
  | { kind: "folder"; folderId: number; label: string }
type DropData = { kind: "folder"; folderId: number } | { kind: "root" }

function OwnerTreeEditor({ owner, nodes }: { owner: Owner; nodes: Node[] }) {
  const qc = useQueryClient()
  const nodeById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const detail = useQuery({
    queryKey: ["access-tree", owner.type, owner.id],
    queryFn: () => accessTreeService.get(owner.type, owner.id),
  })
  const folders = detail.data?.folders ?? []
  const items = detail.data?.items ?? []
  const tree = React.useMemo(() => buildTree(folders, items, nodeById), [folders, items, nodeById])

  const [target, setTarget] = React.useState<number | null>(null)
  const [collapsed, setCollapsed] = React.useState<Set<number>>(new Set())
  const [editing, setEditing] = React.useState<number | null>(null)
  const [editName, setEditName] = React.useState("")
  const [drag, setDrag] = React.useState<DragData | null>(null)

  React.useEffect(() => {
    if (target != null && !folders.some((f) => f.id === target)) setTarget(null)
    if (target == null && folders.length > 0) setTarget(folders[0].id)
  }, [folders, target])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["access-tree", owner.type, owner.id] })
    void qc.invalidateQueries({ queryKey: ["access"] }) // 按人看 / 按资产看 also change
  }
  const onErr = (e: Error) => toast.error("操作失败", { description: e.message })

  const mCreate = useMutation({
    mutationFn: (parent_id: number | null) =>
      accessTreeService.createFolder({ owner_type: owner.type, owner_id: owner.id, name: "新建文件夹", parent_id }),
    onSuccess: (f) => {
      refresh()
      setEditing(f.id)
      setEditName(f.name)
    },
    onError: onErr,
  })
  const mRename = useMutation({
    mutationFn: (v: { id: number; name: string }) => accessTreeService.updateFolder(v.id, { name: v.name }),
    onSuccess: () => {
      setEditing(null)
      refresh()
    },
    onError: onErr,
  })
  const mFolderIcon = useMutation({
    mutationFn: (v: { id: number; icon: string }) => accessTreeService.updateFolder(v.id, { icon: v.icon }),
    onSuccess: refresh,
    onError: onErr,
  })
  const mFolderPerm = useMutation({
    mutationFn: (v: { id: number; actions: string; valid_to: string }) =>
      accessTreeService.updateFolder(v.id, { actions: v.actions, valid_to: v.valid_to }),
    onSuccess: refresh,
    onError: onErr,
  })
  const mDeleteFolder = useMutation({
    mutationFn: (id: number) => accessTreeService.removeFolder(id),
    onSuccess: refresh,
    onError: onErr,
  })
  const mMoveFolder = useMutation({
    mutationFn: (v: { id: number; parent: number | null }) => accessTreeService.moveFolder(v.id, v.parent),
    onSuccess: refresh,
    onError: onErr,
  })
  const mItemPerm = useMutation({
    mutationFn: (v: { id: number; actions: string; valid_to: string }) =>
      accessTreeService.updateItem(v.id, { actions: v.actions, valid_to: v.valid_to }),
    onSuccess: refresh,
    onError: onErr,
  })
  const mMoveItem = useMutation({
    mutationFn: (v: { id: number; folder_id: number }) => accessTreeService.updateItem(v.id, { folder_id: v.folder_id }),
    onSuccess: refresh,
    onError: onErr,
  })
  const mRemoveItem = useMutation({
    mutationFn: (id: number) => accessTreeService.removeItem(id),
    onSuccess: refresh,
    onError: onErr,
  })
  const mAddItems = useMutation({
    mutationFn: (v: { folder_id: number; node_ids: number[] }) =>
      accessTreeService.addItems({ owner_type: owner.type, owner_id: owner.id, folder_id: v.folder_id, node_ids: v.node_ids }),
    onSuccess: (r) => {
      refresh()
      toast.success(`已加入 ${r.added} 个资产`)
    },
    onError: onErr,
  })

  const ctx: EditorCtx = {
    target,
    setTarget,
    collapsed,
    toggle: (fid) =>
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(fid)) next.delete(fid)
        else next.add(fid)
        return next
      }),
    editing,
    editName,
    setEditName,
    startEdit: (f) => {
      setEditing(f.id)
      setEditName(f.name)
    },
    saveEdit: (fid) => (editName.trim() ? mRename.mutate({ id: fid, name: editName.trim() }) : setEditing(null)),
    cancelEdit: () => setEditing(null),
    folderIcon: (fid, icon) => mFolderIcon.mutate({ id: fid, icon }),
    folderPerm: (fid, actions, valid_to) => mFolderPerm.mutate({ id: fid, actions, valid_to }),
    newSub: (parent) => mCreate.mutate(parent),
    deleteFolder: (f) => {
      if (confirm(`删除文件夹「${f.name}」？其子文件夹与资产都会一并移除。`)) mDeleteFolder.mutate(f.id)
    },
    itemPerm: (id, actions, valid_to) => mItemPerm.mutate({ id, actions, valid_to }),
    removeItem: (id) => mRemoveItem.mutate(id),
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const onDragStart = (e: DragStartEvent) => setDrag((e.active.data.current as DragData) ?? null)
  const onDragEnd = (e: DragEndEvent) => {
    setDrag(null)
    const a = e.active.data.current as DragData | undefined
    const o = e.over?.data.current as DropData | undefined
    if (!a || !o) return
    if (a.kind === "lib") {
      if (o.kind === "folder") mAddItems.mutate({ folder_id: o.folderId, node_ids: [a.nodeId] })
    } else if (a.kind === "item") {
      if (o.kind === "folder" && o.folderId !== a.fromFolder) mMoveItem.mutate({ id: a.itemId, folder_id: o.folderId })
    } else if (a.kind === "folder") {
      if (o.kind === "root") {
        mMoveFolder.mutate({ id: a.folderId, parent: null })
      } else if (o.kind === "folder" && o.folderId !== a.folderId) {
        if (subtreeFolderIds(folders, a.folderId).has(o.folderId)) {
          toast.error("不能移动到自己的子文件夹下")
          return
        }
        mMoveFolder.mutate({ id: a.folderId, parent: o.folderId })
      }
    }
  }

  return (
    <Ctx.Provider value={ctx}>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDrag(null)}>
        <div className="grid h-[calc(100vh-15rem)] grid-cols-1 overflow-hidden rounded-lg border lg:grid-cols-[1fr_320px]">
          {/* tree */}
          <div className="flex min-h-0 flex-col border-r">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
              <span className="truncate text-xs font-semibold text-muted-foreground">
                {owner.name} 的资产树 · 拖拽组织层级
              </span>
              <Button variant="outline" size="sm" onClick={() => mCreate.mutate(null)}>
                <FolderPlus className="h-3.5 w-3.5" /> 新建根文件夹
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {detail.isLoading ? (
                <div className="px-2 py-10 text-center text-xs text-muted-foreground">加载中…</div>
              ) : tree.length === 0 ? (
                <div className="px-2 py-10 text-center text-xs text-muted-foreground">
                  还没有文件夹。先「新建根文件夹」，再从右侧把资产拖进来。
                </div>
              ) : (
                <>
                  <RootDropBar active={drag?.kind === "folder"} />
                  <div className="space-y-0.5">{tree.map((n) => renderNode(n, 0))}</div>
                </>
              )}
            </div>
          </div>

          {/* asset library */}
          <AssetLibrary
            nodes={nodes}
            folders={folders}
            target={target}
            onTarget={setTarget}
            onAdd={(nodeIds) => {
              if (target == null) {
                toast.error("先在左侧选择一个目标文件夹")
                return
              }
              mAddItems.mutate({ folder_id: target, node_ids: nodeIds })
            }}
          />
        </div>

        <DragOverlay dropAnimation={null}>
          {drag ? (
            <div className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-sm shadow-md">
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="max-w-[200px] truncate">{drag.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </Ctx.Provider>
  )
}

function renderNode(node: DirItem, depth: number): React.ReactNode {
  if (node.type === "asset") {
    return <ItemRowDnD key={`asset:${node.item.id}`} item={node.item} node={node.node} depth={depth} />
  }
  return <FolderNodeDnD key={`folder:${node.fid}`} node={node} depth={depth} />
}

// ---- the "move to top level" drop zone (only meaningful while dragging a folder) ----

function RootDropBar({ active }: { active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "droproot", data: { kind: "root" } as DropData })
  if (!active) return null
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "mb-1 flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground",
        isOver ? "border-primary bg-primary/[0.06] text-primary" : "",
      )}
    >
      <CornerLeftUp className="h-3.5 w-3.5" /> 拖到此处移到顶层
    </div>
  )
}

// ---- folder node (draggable + droppable + recursive children) ----

function FolderNodeDnD({ node, depth }: { node: Extract<DirItem, { type: "folder" }>; depth: number }) {
  const ed = useEditor()
  const f = node.folder
  const drag = useDraggable({ id: `folder:${f.id}`, data: { kind: "folder", folderId: f.id, label: f.name } as DragData })
  const drop = useDroppable({ id: `dropf:${f.id}`, data: { kind: "folder", folderId: f.id } as DropData })
  const setRef = (el: HTMLElement | null) => {
    drag.setNodeRef(el)
    drop.setNodeRef(el)
  }
  const count = node.children.filter((c) => c.type === "asset").length
  const hasKids = node.children.length > 0
  const open = !ed.collapsed.has(f.id)
  const editing = ed.editing === f.id

  return (
    <div>
      <div
        ref={setRef}
        {...(editing ? {} : drag.listeners)}
        {...drag.attributes}
        onClick={() => ed.setTarget(f.id)}
        style={{ paddingLeft: depth * 16 }}
        className={cn(
          "group/row flex items-center gap-1 rounded-md py-1 pr-1 text-sm",
          drag.isDragging && "opacity-40",
          drop.isOver
            ? "bg-primary/[0.08] ring-2 ring-inset ring-primary/50"
            : ed.target === f.id
              ? "bg-primary/[0.06] ring-1 ring-inset ring-primary/25"
              : "hover:bg-muted/60",
        )}
      >
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            if (hasKids) ed.toggle(f.id)
          }}
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground/70 hover:text-foreground"
        >
          {hasKids ? <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} /> : null}
        </button>

        {editing ? (
          <div className="flex flex-1 items-center gap-1.5" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <IconPicker value={f.icon} onChange={(icon) => ed.folderIcon(f.id, icon)} />
            <Input
              autoFocus
              value={ed.editName}
              onChange={(e) => ed.setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") ed.saveEdit(f.id)
                if (e.key === "Escape") ed.cancelEdit()
              }}
              className="h-7 flex-1 text-sm"
            />
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => ed.saveEdit(f.id)}>
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={ed.cancelEdit}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <>
            <AppIcon icon={f.icon} fallback="lucide:folder" size={15} className="shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate font-medium">{f.name}</span>
            <Badge variant="outline" className="shrink-0 font-normal text-[10px]">
              {permSummary(f.actions)}
            </Badge>
            <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{count}</span>
            <span className="hidden shrink-0 items-center gap-0.5 group-hover/row:flex">
              <PermPopover actions={f.actions} validTo={f.valid_to} onApply={(a, t) => ed.folderPerm(f.id, a, t)} />
              <RowBtn title="新建子文件夹" onClick={() => ed.newSub(f.id)}>
                <FolderPlus className="h-3.5 w-3.5" />
              </RowBtn>
              <RowBtn title="重命名" onClick={() => ed.startEdit(f)}>
                <Pencil className="h-3.5 w-3.5" />
              </RowBtn>
              <RowBtn title="删除" onClick={() => ed.deleteFolder(f)} danger>
                <Trash2 className="h-3.5 w-3.5" />
              </RowBtn>
            </span>
          </>
        )}
      </div>
      {open && hasKids ? <div>{node.children.map((c) => renderNode(c, depth + 1))}</div> : null}
    </div>
  )
}

// ---- asset item row (draggable between folders) ----

function ItemRowDnD({ item, node, depth }: { item: AccessItem; node?: Node; depth: number }) {
  const ed = useEditor()
  const drag = useDraggable({
    id: `item:${item.id}`,
    data: { kind: "item", itemId: item.id, fromFolder: item.folder_id, label: node?.name ?? `#${item.node_id}` } as DragData,
  })
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      style={{ paddingLeft: depth * 16 + 20 }}
      className={cn(
        "group/row flex items-center gap-1.5 rounded-md py-1 pr-1 text-sm hover:bg-muted/50",
        drag.isDragging && "opacity-40",
      )}
    >
      <AppIcon icon={node?.icon} fallback="lucide:server" size={14} className="shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{node ? node.name : `#${item.node_id}（已删除）`}</span>
      <Badge variant="outline" className="shrink-0 font-normal text-[10px]">
        {permSummary(item.actions)}
      </Badge>
      {node && <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{node.host}</span>}
      <span className="flex shrink-0 items-center gap-0.5">
        <PermPopover actions={item.actions} validTo={item.valid_to} onApply={(a, t) => ed.itemPerm(item.id, a, t)} />
        <RowBtn title="移除" onClick={() => ed.removeItem(item.id)} danger>
          <X className="h-3.5 w-3.5" />
        </RowBtn>
      </span>
    </div>
  )
}

function RowBtn({
  children,
  title,
  onClick,
  danger,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        "grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-foreground/10",
        danger ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function permSummary(actions?: string): string {
  if (!actions) return "继承"
  const codes = actions.split(",").filter(Boolean)
  const preset = PRESETS.find((p) => p.actions.slice().sort().join(",") === codes.slice().sort().join(","))
  return preset ? preset.label : codes.map(actionLabel).join(" · ")
}

// ---- inline permission editor ----

type ValidMode = "inherit" | "7d" | "30d" | "90d" | "custom"

function PermPopover({
  actions,
  validTo,
  onApply,
}: {
  actions?: string
  validTo?: string | null
  onApply: (actions: string, valid_to: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [presetKey, setPresetKey] = React.useState<string>("inherit")
  const [validMode, setValidMode] = React.useState<ValidMode>("inherit")
  const [customTo, setCustomTo] = React.useState("")

  React.useEffect(() => {
    if (!open) return
    const codes = (actions ?? "").split(",").filter(Boolean)
    if (codes.length === 0) setPresetKey("inherit")
    else {
      const p = PRESETS.find((x) => x.actions.slice().sort().join(",") === codes.slice().sort().join(","))
      setPresetKey(p ? p.key : "full")
    }
    setValidMode(validTo ? "custom" : "inherit")
    setCustomTo(validTo ? String(validTo).slice(0, 16) : "")
  }, [open, actions, validTo])

  const apply = () => {
    const acts = presetKey === "inherit" ? "" : PRESETS.find((p) => p.key === presetKey)?.actions.join(",") ?? ""
    let to = ""
    if (validMode === "custom") to = customTo
    else if (validMode !== "inherit") {
      const days = validMode === "7d" ? 7 : validMode === "30d" ? 30 : 90
      const d = new Date()
      d.setDate(d.getDate() + days)
      to = d.toISOString()
    }
    onApply(acts, to)
    setOpen(false)
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
            <Chip on={presetKey === "inherit"} onClick={() => setPresetKey("inherit")}>
              继承
            </Chip>
            {PRESETS.map((p) => (
              <Chip key={p.key} on={presetKey === p.key} onClick={() => setPresetKey(p.key)} title={p.desc}>
                {p.label}
              </Chip>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">有效期</Label>
          <div className="flex flex-wrap gap-1.5">
            {(["inherit", "7d", "30d", "90d", "custom"] as ValidMode[]).map((m) => (
              <Chip key={m} on={validMode === m} onClick={() => setValidMode(m)}>
                {m === "inherit" ? "继承" : m === "custom" ? "自定义" : m === "7d" ? "7 天" : m === "30d" ? "30 天" : "90 天"}
              </Chip>
            ))}
          </div>
          {validMode === "custom" && (
            <Input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8" />
          )}
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={apply}>
            应用
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Chip({
  children,
  on,
  onClick,
  title,
}: {
  children: React.ReactNode
  on: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-1 text-xs transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
      )}
    >
      {children}
    </button>
  )
}

// ---- asset library (rows draggable into folders; button is the fallback) ----

function AssetLibrary({
  nodes,
  folders,
  target,
  onTarget,
  onAdd,
}: {
  nodes: Node[]
  folders: AccessFolder[]
  target: number | null
  onTarget: (id: number) => void
  onAdd: (nodeIds: number[]) => void
}) {
  const [q, setQ] = React.useState("")
  const [checked, setChecked] = React.useState<Set<number>>(new Set())
  const filtered = React.useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return nodes
    return nodes.filter((n) =>
      [n.name, n.host, n.protocol].filter(Boolean).some((v) => String(v).toLowerCase().includes(k)),
    )
  }, [nodes, q])
  const toggle = (id: number) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }
  const folderLabel = React.useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]))
    return (f: AccessFolder) => {
      const parts: string[] = []
      let cur: AccessFolder | undefined = f
      let guard = 0
      while (cur && guard++ < 50) {
        parts.unshift(cur.name)
        cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined
      }
      return parts.join(" / ")
    }
  }, [folders])

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="text-xs font-semibold text-muted-foreground">资产库（全局）· 可拖入左侧文件夹</div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 名称 / IP / 协议…" className="h-8 pl-7 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">目标文件夹（勾选后用按钮加入）</Label>
          <Select value={target != null ? String(target) : undefined} onValueChange={(v) => onTarget(Number(v))}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder={folders.length ? "选择文件夹" : "先建文件夹"} />
            </SelectTrigger>
            <SelectContent>
              {folders.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {folderLabel(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">新资产默认继承文件夹权限，可在行内单独调整。</p>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 p-2">
          {filtered.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground">没有匹配的资产</div>
          ) : (
            filtered.map((n) => <LibRowDnD key={n.id} node={n} checked={checked.has(n.id)} onToggle={() => toggle(n.id)} />)
          )}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2.5">
        <span className="text-xs text-muted-foreground">已选 {checked.size}</span>
        <Button
          size="sm"
          disabled={checked.size === 0 || target == null}
          onClick={() => {
            onAdd([...checked])
            setChecked(new Set())
          }}
        >
          <ChevronRight className="h-3.5 w-3.5" /> 加入目录
        </Button>
      </div>
    </div>
  )
}

function LibRowDnD({ node, checked, onToggle }: { node: Node; checked: boolean; onToggle: () => void }) {
  const drag = useDraggable({ id: `lib:${node.id}`, data: { kind: "lib", nodeId: node.id, label: node.name } as DragData })
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      className={cn(
        "flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent active:cursor-grabbing",
        drag.isDragging && "opacity-40",
      )}
    >
      <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={onToggle} />
      </span>
      <AppIcon icon={node.icon} fallback="lucide:server" size={14} className="shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{node.name}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{node.host}</span>
    </div>
  )
}
