"use client"

// 资产目录（按对象）：选一个用户 / 用户组 / 部门 → 直接搭建 TA 专属的多级资产树。
// 放进文件夹即授权；权限/有效期可在文件夹或资产上行内设，子级继承父文件夹、可覆盖。
//
// 体验:@dnd-kit/core 拖拽(资产库→文件夹 / 资产跨文件夹 / 文件夹改层级,PointerSensor
// 6px 阈值不误触 + DragOverlay) · motion 展开折叠动效 · react-virtuoso 虚拟化资产库。

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
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Virtuoso } from "react-virtuoso"
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  CornerLeftUp,
  FolderPlus,
  GripVertical,
  Pencil,
  Plus,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
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
        <EmptyState
          icon="lucide:folder-tree"
          title="选一个对象，开始搭建资产树"
          hint="用户 / 用户组 / 部门都行，组和部门的树会被成员继承。"
        />
      ) : (
        <OwnerTreeEditor key={`${owner.type}:${owner.id}`} owner={owner} ownerCats={ownerCats} nodes={nodes} />
      )}
    </div>
  )
}

function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-12 text-center">
      <AppIcon icon={icon} size={28} className="text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

// ---- owner picker (头像 + 分组搜索) ----

function OwnerAvatar({ cat, size = 22 }: { cat?: OwnerCat; size?: number }) {
  const Icon = cat?.icon
  return (
    <span
      className="grid shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      style={{ width: size, height: size }}
    >
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
                  <CommandItem
                    key={`${c.key}:${i.id}`}
                    value={`${c.label} ${i.name} ${i.sub ?? ""}`}
                    onSelect={() => {
                      onChange({ type: c.key, id: i.id, name: i.name })
                      setOpen(false)
                    }}
                    className="gap-2"
                  >
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

function subtreeFolderIds(folders: AccessFolder[], fid: number): Set<number> {
  const self = folders.find((f) => f.id === fid)
  const out = new Set<number>([fid])
  if (!self) return out
  for (const f of folders) if (f.path === self.path || f.path.startsWith(self.path + "/")) out.add(f.id)
  return out
}

// ---- editor context ----

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

type DragData =
  | { kind: "lib"; nodeId: number; label: string }
  | { kind: "item"; itemId: number; fromFolder: number; label: string }
  | { kind: "folder"; folderId: number; label: string }
type DropData = { kind: "folder"; folderId: number } | { kind: "root" }

function OwnerTreeEditor({ owner, ownerCats, nodes }: { owner: Owner; ownerCats: OwnerCat[]; nodes: Node[] }) {
  const qc = useQueryClient()
  const cur = ownerCats.find((c) => c.key === owner.type)
  const nodeById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const detail = useQuery({
    queryKey: ["access-tree", owner.type, owner.id],
    queryFn: () => accessTreeService.get(owner.type, owner.id),
  })
  const folders = detail.data?.folders ?? []
  const items = detail.data?.items ?? []
  const tree = React.useMemo(() => buildTree(folders, items, nodeById), [folders, items, nodeById])
  const placed = React.useMemo(() => new Set(items.map((i) => i.node_id)), [items])

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
    void qc.invalidateQueries({ queryKey: ["access"] })
  }
  const onErr = (e: Error) => toast.error("操作失败", { description: e.message })

  const mCreate = useMutation({
    mutationFn: (parent_id: number | null) =>
      accessTreeService.createFolder({ owner_type: owner.type, owner_id: owner.id, name: "新建文件夹", parent_id }),
    onSuccess: (f) => {
      refresh()
      setEditing(f.id)
      setEditName(f.name)
      setTarget(f.id)
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
      if (o.kind === "root") mMoveFolder.mutate({ id: a.folderId, parent: null })
      else if (o.kind === "folder" && o.folderId !== a.folderId) {
        if (subtreeFolderIds(folders, a.folderId).has(o.folderId)) {
          toast.error("不能移动到自己的子文件夹下")
          return
        }
        mMoveFolder.mutate({ id: a.folderId, parent: o.folderId })
      }
    }
  }

  const targetName = target != null ? folders.find((f) => f.id === target)?.name : undefined

  return (
    <Ctx.Provider value={ctx}>
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDrag(null)}>
        <div className="grid h-[calc(100vh-14rem)] grid-cols-1 overflow-hidden rounded-xl border lg:grid-cols-[1fr_320px]">
          {/* tree */}
          <div className="flex min-h-0 flex-col border-r">
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
              <OwnerAvatar cat={cur} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{owner.name}</span>
              <Button variant="outline" size="sm" onClick={() => mCreate.mutate(null)}>
                <FolderPlus className="h-3.5 w-3.5" /> 新建文件夹
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {detail.isLoading ? (
                <div className="px-2 py-10 text-center text-xs text-muted-foreground">加载中…</div>
              ) : tree.length === 0 ? (
                <button
                  type="button"
                  onClick={() => mCreate.mutate(null)}
                  className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed px-3 py-10 text-center text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  <Plus className="h-5 w-5" />
                  <span className="text-sm font-medium">新建第一个文件夹</span>
                  <span className="text-xs">再把右侧资产拖进来</span>
                </button>
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
            placed={placed}
            target={target}
            targetName={targetName}
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
            <div className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-sm shadow-lg">
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
  if (node.type === "asset") return <ItemRowDnD key={`asset:${node.item.id}`} item={node.item} node={node.node} depth={depth} />
  return <FolderNodeDnD key={`folder:${node.fid}`} node={node} depth={depth} />
}

function RootDropBar({ active }: { active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "droproot", data: { kind: "root" } as DropData })
  return (
    <AnimatePresence initial={false}>
      {active ? (
        <motion.div
          ref={setNodeRef}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.14 }}
          className="overflow-hidden"
        >
          <div
            className={cn(
              "mb-1 flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground",
              isOver && "border-primary bg-primary/[0.06] text-primary",
            )}
          >
            <CornerLeftUp className="h-3.5 w-3.5" /> 拖到此处移到顶层
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

// override-only permission chip (inherited rows show nothing → clean tree)
function PermBadge({ actions, validTo }: { actions?: string; validTo?: string | null }) {
  const codes = (actions ?? "").split(",").filter(Boolean)
  if (codes.length === 0 && !validTo) return null
  const label = codes.length
    ? PRESETS.find((p) => p.actions.slice().sort().join(",") === codes.slice().sort().join(","))?.label ??
      codes.map(actionLabel).join(" · ")
    : null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {label ? (
        <Badge variant="secondary" className="font-normal text-[10px]">
          {label}
        </Badge>
      ) : null}
      {validTo ? <Clock className="h-3 w-3 text-warning" /> : null}
    </span>
  )
}

function FolderNodeDnD({ node, depth }: { node: Extract<DirItem, { type: "folder" }>; depth: number }) {
  const ed = useEditor()
  const reduce = useReducedMotion()
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
          "group/row flex cursor-grab items-center gap-1 rounded-md py-1 pr-1 text-sm active:cursor-grabbing",
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
            <PermBadge actions={f.actions} validTo={f.valid_to} />
            {count > 0 ? <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{count}</span> : null}
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
      <AnimatePresence initial={false}>
        {open && hasKids ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
            className="overflow-hidden"
          >
            {node.children.map((c) => renderNode(c, depth + 1))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

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
        "group/row flex cursor-grab items-center gap-1.5 rounded-md py-1 pr-1 text-sm hover:bg-muted/50 active:cursor-grabbing",
        drag.isDragging && "opacity-40",
      )}
    >
      <AppIcon icon={node?.icon} fallback="lucide:server" size={14} className="shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{node ? node.name : `#${item.node_id}（已删除）`}</span>
      <PermBadge actions={item.actions} validTo={item.valid_to} />
      {node ? <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{node.host}</span> : null}
      <span className="flex shrink-0 items-center gap-0.5">
        <PermPopover actions={item.actions} validTo={item.valid_to} onApply={(a, t) => ed.itemPerm(item.id, a, t)} />
        <RowBtn title="移除" onClick={() => ed.removeItem(item.id)} danger>
          <X className="h-3.5 w-3.5" />
        </RowBtn>
      </span>
    </div>
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
      className={cn(
        "grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-foreground/10",
        danger ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
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
          {validMode === "custom" ? (
            <Input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8" />
          ) : null}
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

function Chip({ children, on, onClick, title }: { children: React.ReactNode; on: boolean; onClick: () => void; title?: string }) {
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

// ---- asset library (虚拟化 + 可拖入 + 已放置标记) ----

function AssetLibrary({
  nodes,
  placed,
  target,
  targetName,
  onAdd,
}: {
  nodes: Node[]
  placed: Set<number>
  target: number | null
  targetName?: string
  onAdd: (nodeIds: number[]) => void
}) {
  const [q, setQ] = React.useState("")
  const [checked, setChecked] = React.useState<Set<number>>(new Set())
  const filtered = React.useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return nodes
    return nodes.filter((n) => [n.name, n.host, n.protocol].filter(Boolean).some((v) => String(v).toLowerCase().includes(k)))
  }, [nodes, q])
  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground">资产库</span>
          <span className="text-[10px] text-muted-foreground">拖到左侧文件夹</span>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 名称 / IP / 协议…" className="h-8 pl-7 text-sm" />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">没有匹配的资产</div>
        ) : (
          <Virtuoso
            style={{ height: "100%" }}
            data={filtered}
            itemContent={(_, n) => (
              <div className="px-2">
                <LibRowDnD node={n} checked={checked.has(n.id)} onToggle={() => toggle(n.id)} placed={placed.has(n.id)} />
              </div>
            )}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2.5">
        <span className="text-xs text-muted-foreground">已选 {checked.size}</span>
        <Button
          size="sm"
          disabled={checked.size === 0 || target == null}
          onClick={() => {
            onAdd([...checked])
            setChecked(new Set())
          }}
          title={target == null ? "先在左侧选择文件夹" : undefined}
        >
          <ChevronRight className="h-3.5 w-3.5" /> {targetName ? `加入「${targetName}」` : "加入目录"}
        </Button>
      </div>
    </div>
  )
}

function LibRowDnD({ node, checked, onToggle, placed }: { node: Node; checked: boolean; onToggle: () => void; placed: boolean }) {
  const drag = useDraggable({ id: `lib:${node.id}`, data: { kind: "lib", nodeId: node.id, label: node.name } as DragData })
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      className={cn(
        "my-0.5 flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent active:cursor-grabbing",
        drag.isDragging && "opacity-40",
      )}
    >
      <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={onToggle} />
      </span>
      <AppIcon icon={node.icon} fallback="lucide:server" size={14} className="shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{node.name}</span>
      {placed ? (
        <Badge variant="outline" className="shrink-0 gap-0.5 font-normal text-[10px] text-muted-foreground">
          <Check className="h-2.5 w-2.5" /> 已在目录
        </Badge>
      ) : null}
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{node.host}</span>
    </div>
  )
}
