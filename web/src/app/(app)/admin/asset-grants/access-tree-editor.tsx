"use client"

// 资产目录（按对象）：选一个用户 / 用户组 / 部门 → 直接搭建 TA 专属的多级资产树。
// 把资产放进文件夹就等于授权；权限/有效期可在文件夹或单个资产上行内设置（子级
// 继承父文件夹、可覆盖）。组/部门的树被成员继承。树即授权，无单独分配步骤。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  FolderPlus,
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
import { TreeList } from "@/components/common/tree-list"
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

// ---- per-owner tree editor ----

type DirItem =
  | { type: "folder"; id: string; fid: number; folder: AccessFolder; children: DirItem[] }
  | { type: "asset"; id: string; item: AccessItem; node?: Node }

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
    const assets: DirItem[] = (itemsByFolder.get(f.id) ?? []).map((it) => ({
      type: "asset",
      id: `asset:${it.id}`,
      item: it,
      node: nodeById.get(it.node_id),
    }))
    return { type: "folder", id: `folder:${f.id}`, fid: f.id, folder: f, children: [...childFolders, ...assets] }
  }
  return (childrenOf.get(0) ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(makeFolder)
}

function collectFolderIds(items: DirItem[]): string[] {
  const out: string[] = []
  const walk = (arr: DirItem[]) => {
    for (const it of arr) {
      if (it.type === "folder") {
        out.push(it.id)
        walk(it.children)
      }
    }
  }
  walk(items)
  return out
}

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
  const [editing, setEditing] = React.useState<number | null>(null)
  const [editName, setEditName] = React.useState("")

  React.useEffect(() => {
    if (target != null && !folders.some((f) => f.id === target)) setTarget(null)
    if (target == null && folders.length > 0) setTarget(folders[0].id)
  }, [folders, target])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["access-tree", owner.type, owner.id] })
    // The merged "按人看 / 按资产看" views also change.
    void qc.invalidateQueries({ queryKey: ["access"] })
  }
  const onErr = (e: Error) => toast.error("操作失败", { description: e.message })

  const createFolder = useMutation({
    mutationFn: (parent_id: number | null) =>
      accessTreeService.createFolder({ owner_type: owner.type, owner_id: owner.id, name: "新建文件夹", parent_id }),
    onSuccess: (f) => {
      refresh()
      setEditing(f.id)
      setEditName(f.name)
    },
    onError: onErr,
  })
  const renameFolder = useMutation({
    mutationFn: (v: { id: number; name: string }) => accessTreeService.updateFolder(v.id, { name: v.name }),
    onSuccess: () => {
      setEditing(null)
      refresh()
    },
    onError: onErr,
  })
  const folderIcon = useMutation({
    mutationFn: (v: { id: number; icon: string }) => accessTreeService.updateFolder(v.id, { icon: v.icon }),
    onSuccess: refresh,
    onError: onErr,
  })
  const folderPerm = useMutation({
    mutationFn: (v: { id: number; actions: string; valid_to: string }) =>
      accessTreeService.updateFolder(v.id, { actions: v.actions, valid_to: v.valid_to }),
    onSuccess: refresh,
    onError: onErr,
  })
  const deleteFolder = useMutation({
    mutationFn: (id: number) => accessTreeService.removeFolder(id),
    onSuccess: refresh,
    onError: onErr,
  })
  const moveFolder = useMutation({
    mutationFn: (v: { id: number; parent: number | null }) => accessTreeService.moveFolder(v.id, v.parent),
    onSuccess: refresh,
    onError: onErr,
  })
  const itemPerm = useMutation({
    mutationFn: (v: { id: number; actions: string; valid_to: string }) =>
      accessTreeService.updateItem(v.id, { actions: v.actions, valid_to: v.valid_to }),
    onSuccess: refresh,
    onError: onErr,
  })
  const removeItem = useMutation({
    mutationFn: (id: number) => accessTreeService.removeItem(id),
    onSuccess: refresh,
    onError: onErr,
  })

  return (
    <div className="grid h-[calc(100vh-15rem)] grid-cols-1 overflow-hidden rounded-lg border lg:grid-cols-[1fr_320px]">
      {/* tree */}
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <span className="truncate text-xs font-semibold text-muted-foreground">
            {owner.name} 的资产树 · 拖拽文件夹改层级
          </span>
          <Button variant="outline" size="sm" onClick={() => createFolder.mutate(null)}>
            <FolderPlus className="h-3.5 w-3.5" /> 新建根文件夹
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {detail.isLoading ? (
            <div className="px-2 py-10 text-center text-xs text-muted-foreground">加载中…</div>
          ) : tree.length === 0 ? (
            <div className="px-2 py-10 text-center text-xs text-muted-foreground">
              还没有文件夹。先「新建根文件夹」，再从右侧把资产加进去。
            </div>
          ) : (
            <TreeList<DirItem>
              key={`${owner.type}:${owner.id}:${folders.length}`}
              nodes={tree}
              getId={(it) => it.id}
              getChildren={(it) => (it.type === "folder" ? it.children : undefined)}
              defaultExpandedIds={collectFolderIds(tree)}
              indent={16}
              onMove={(sourceId, targetId) => {
                if (!sourceId.startsWith("folder:")) return
                const id = Number(sourceId.slice("folder:".length))
                const parent = targetId && targetId.startsWith("folder:") ? Number(targetId.slice("folder:".length)) : null
                moveFolder.mutate({ id, parent })
              }}
              canDrag={(it) => it.type === "folder"}
              renderRow={(it) =>
                it.type === "folder" ? (
                  <FolderRow
                    item={it}
                    active={target === it.fid}
                    editing={editing === it.fid}
                    editName={editName}
                    onPick={() => setTarget(it.fid)}
                    onStartEdit={() => {
                      setEditing(it.fid)
                      setEditName(it.folder.name)
                    }}
                    onEditName={setEditName}
                    onSaveEdit={() => (editName.trim() ? renameFolder.mutate({ id: it.fid, name: editName.trim() }) : setEditing(null))}
                    onCancelEdit={() => setEditing(null)}
                    onIcon={(icon) => folderIcon.mutate({ id: it.fid, icon })}
                    onPerm={(actions, valid_to) => folderPerm.mutate({ id: it.fid, actions, valid_to })}
                    onNewSub={() => createFolder.mutate(it.fid)}
                    onDelete={() => {
                      if (confirm(`删除文件夹「${it.folder.name}」？其子文件夹与资产都会一并移除。`)) deleteFolder.mutate(it.fid)
                    }}
                  />
                ) : (
                  <AssetRow
                    item={it}
                    onPerm={(actions, valid_to) => itemPerm.mutate({ id: it.item.id, actions, valid_to })}
                    onRemove={() => removeItem.mutate(it.item.id)}
                  />
                )
              }
            />
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
          accessTreeService
            .addItems({ owner_type: owner.type, owner_id: owner.id, folder_id: target, node_ids: nodeIds })
            .then((r) => {
              refresh()
              toast.success(`已加入 ${r.added} 个资产`)
            })
            .catch(onErr)
        }}
      />
    </div>
  )
}

// ---- rows ----

function permSummary(actions?: string): string {
  if (!actions) return "继承"
  const codes = actions.split(",").filter(Boolean)
  const preset = PRESETS.find((p) => p.actions.slice().sort().join(",") === codes.slice().sort().join(","))
  return preset ? preset.label : codes.map(actionLabel).join(" · ")
}

function FolderRow({
  item,
  active,
  editing,
  editName,
  onPick,
  onStartEdit,
  onEditName,
  onSaveEdit,
  onCancelEdit,
  onIcon,
  onPerm,
  onNewSub,
  onDelete,
}: {
  item: Extract<DirItem, { type: "folder" }>
  active: boolean
  editing: boolean
  editName: string
  onPick: () => void
  onStartEdit: () => void
  onEditName: (v: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onIcon: (icon: string) => void
  onPerm: (actions: string, valid_to: string) => void
  onNewSub: () => void
  onDelete: () => void
}) {
  const count = item.children.filter((c) => c.type === "asset").length
  if (editing) {
    return (
      <div className="flex items-center gap-1.5 py-0.5 pr-1" onClick={(e) => e.stopPropagation()}>
        <IconPicker value={item.folder.icon} onChange={onIcon} />
        <Input
          autoFocus
          value={editName}
          onChange={(e) => onEditName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSaveEdit()
            if (e.key === "Escape") onCancelEdit()
          }}
          className="h-7 flex-1 text-sm"
        />
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onSaveEdit}>
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onCancelEdit}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    )
  }
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md py-1 pr-1 text-sm",
        active && "bg-primary/[0.06] ring-1 ring-inset ring-primary/25",
      )}
      onClick={onPick}
    >
      <AppIcon icon={item.folder.icon} fallback="lucide:folder" size={15} className="shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate font-medium">{item.folder.name}</span>
      <Badge variant="outline" className="shrink-0 font-normal text-[10px]">
        {permSummary(item.folder.actions)}
      </Badge>
      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{count}</span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover/tree:flex">
        <PermPopover actions={item.folder.actions} validTo={item.folder.valid_to} onApply={onPerm} />
        <RowBtn title="新建子文件夹" onClick={onNewSub}>
          <FolderPlus className="h-3.5 w-3.5" />
        </RowBtn>
        <RowBtn title="重命名" onClick={onStartEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </RowBtn>
        <RowBtn title="删除" onClick={onDelete} danger>
          <Trash2 className="h-3.5 w-3.5" />
        </RowBtn>
      </span>
    </div>
  )
}

function AssetRow({
  item,
  onPerm,
  onRemove,
}: {
  item: Extract<DirItem, { type: "asset" }>
  onPerm: (actions: string, valid_to: string) => void
  onRemove: () => void
}) {
  const n = item.node
  return (
    <div className="flex items-center gap-1.5 py-1 pr-1 text-sm" onClick={(e) => e.stopPropagation()}>
      <AppIcon icon={n?.icon} fallback="lucide:server" size={14} className="shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{n ? n.name : `#${item.item.node_id}（已删除）`}</span>
      <Badge variant="outline" className="shrink-0 font-normal text-[10px]">
        {permSummary(item.item.actions)}
      </Badge>
      {n && <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{n.host}</span>}
      <span className="flex shrink-0 items-center gap-0.5">
        <PermPopover actions={item.item.actions} validTo={item.item.valid_to} onApply={onPerm} />
        <RowBtn title="移除" onClick={onRemove} danger>
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
  // "" preset = inherit. Otherwise match a preset by action set.
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
          onClick={(e) => e.stopPropagation()}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3" align="end" onClick={(e) => e.stopPropagation()}>
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

// ---- asset library ----

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
        <div className="text-xs font-semibold text-muted-foreground">资产库（全局）</div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 名称 / IP / 协议…" className="h-8 pl-7 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">目标文件夹</Label>
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
            filtered.map((n) => (
              <label key={n.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <Checkbox checked={checked.has(n.id)} onCheckedChange={() => toggle(n.id)} />
                <AppIcon icon={n.icon} fallback="lucide:server" size={14} className="shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{n.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{n.host}</span>
              </label>
            ))
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
