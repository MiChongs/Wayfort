"use client"

// 授权目录工作台：管理员从零搭一套多级文件夹、把资产拖入任意层级，再分配给
// 用户 / 用户组 / 部门，或做成可复用模板。目录独立于全局资产树；用户在工作区
// 的「我的目录」视图里看到的就是这棵被过滤后的树。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CalendarClock,
  Check,
  ChevronRight,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { MultiPicker, parseRef, useGrantDirectories } from "@/components/admin/grant-wizard"
import { catalogService, nodeService } from "@/lib/api/services"
import type {
  Catalog,
  CatalogAssignment,
  CatalogFolder,
  CatalogPlacement,
  GranteeKind,
  Node,
} from "@/lib/api/types"
import { PRESETS, actionLabel, summarizeActions } from "@/lib/access/permissions"

export default function CatalogsPage() {
  const [selectedId, setSelectedId] = React.useState<number | null>(null)
  const catalogs = useQuery({ queryKey: ["catalogs"], queryFn: catalogService.list })
  const list = catalogs.data?.catalogs ?? []

  // Default-select the first catalog once loaded.
  React.useEffect(() => {
    if (selectedId == null && list.length > 0) setSelectedId(list[0].id)
  }, [list, selectedId])

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">授权目录</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            为用户搭建独立于全局资产树的多级目录，分配给个人 / 组 / 部门，或做成可复用模板。
          </p>
        </div>
        <NewCatalogButton onCreated={(c) => setSelectedId(c.id)} />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* Left rail: catalog / template list */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="shrink-0 border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
            目录 · {list.length}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1 p-2">
              {list.length === 0 ? (
                <div className="px-2 py-8 text-center text-xs text-muted-foreground">
                  还没有目录，点右上角「新建目录」
                </div>
              ) : (
                list.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                      c.id === selectedId
                        ? "border-primary bg-primary/[0.06] ring-1 ring-inset ring-primary/30"
                        : "border-transparent hover:bg-accent",
                    )}
                  >
                    <AppIcon icon={c.icon} fallback="lucide:folder-kanban" size={18} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.name}</span>
                      {c.description && (
                        <span className="block truncate text-xs text-muted-foreground">{c.description}</span>
                      )}
                    </span>
                    {c.is_template && (
                      <Badge variant="secondary" className="shrink-0 font-normal">
                        模板
                      </Badge>
                    )}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right: editor */}
        <div className="min-h-0 overflow-hidden rounded-xl border bg-card">
          {selectedId != null ? (
            <CatalogEditor
              key={selectedId}
              catalogId={selectedId}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <div className="grid h-full place-items-center p-10 text-center text-sm text-muted-foreground">
              选择左侧目录开始编辑，或新建一个。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NewCatalogButton({ onCreated }: { onCreated: (c: Catalog) => void }) {
  const qc = useQueryClient()
  const create = useMutation({
    mutationFn: () => catalogService.create({ name: "新建目录" }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["catalogs"] })
      onCreated(c)
      toast.success("已新建目录", { description: "在右侧重命名并搭建结构" })
    },
    onError: (e: Error) => toast.error("新建失败", { description: e.message }),
  })
  return (
    <Button onClick={() => create.mutate()} disabled={create.isPending}>
      <Plus className="h-4 w-4" /> 新建目录
    </Button>
  )
}

// ---------- Editor ----------

type Tab = "structure" | "assign"

function CatalogEditor({ catalogId, onDeleted }: { catalogId: number; onDeleted: () => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = React.useState<Tab>("structure")
  const detail = useQuery({ queryKey: ["catalog", catalogId], queryFn: () => catalogService.get(catalogId) })
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: nodeService.list })

  const refresh = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["catalog", catalogId] })
    void qc.invalidateQueries({ queryKey: ["catalogs"] })
  }, [qc, catalogId])

  const cat = detail.data?.catalog

  const updateMeta = useMutation({
    mutationFn: (body: { name?: string; icon?: string; is_template?: boolean }) =>
      catalogService.update(catalogId, body),
    onSuccess: refresh,
    onError: (e: Error) => toast.error("保存失败", { description: e.message }),
  })
  const remove = useMutation({
    mutationFn: () => catalogService.remove(catalogId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["catalogs"] })
      onDeleted()
      toast.success("目录已删除")
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  const [nameDraft, setNameDraft] = React.useState("")
  React.useEffect(() => {
    if (cat) setNameDraft(cat.name)
  }, [cat])

  if (detail.isLoading || !cat) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">加载目录…</div>
  }

  return (
    <div className="flex h-full flex-col">
      {/* Editor toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <IconPicker value={cat.icon} onChange={(t) => updateMeta.mutate({ icon: t })} />
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            if (nameDraft.trim() && nameDraft !== cat.name) updateMeta.mutate({ name: nameDraft.trim() })
          }}
          className="h-9 max-w-xs font-medium"
        />
        <label className="ml-2 flex cursor-pointer items-center gap-2 text-sm">
          <Switch checked={!!cat.is_template} onCheckedChange={(v) => updateMeta.mutate({ is_template: v })} />
          可复用模板
        </label>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              if (confirm(`删除目录「${cat.name}」？其文件夹、资产放置与分配都会一并移除。`)) remove.mutate()
            }}
          >
            <Trash2 className="h-4 w-4" /> 删除目录
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 gap-1 border-b px-4 pt-2">
        {([
          ["structure", "目录结构"],
          ["assign", `分配${detail.data?.assignments?.length ? ` · ${detail.data.assignments.length}` : ""}`],
        ] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              "rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === k
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tab === "structure" ? (
          <StructureTab
            catalogId={catalogId}
            folders={detail.data?.folders ?? []}
            placements={detail.data?.placements ?? []}
            nodes={nodes.data?.nodes ?? []}
            onChanged={refresh}
          />
        ) : (
          <AssignTab
            catalogId={catalogId}
            folders={detail.data?.folders ?? []}
            assignments={detail.data?.assignments ?? []}
            onChanged={refresh}
          />
        )}
      </div>
    </div>
  )
}

// ---------- Structure tab: directory tree + asset library ----------

type DirItem =
  | { type: "folder"; id: string; fid: number; folder: CatalogFolder; children: DirItem[] }
  | { type: "asset"; id: string; placement: CatalogPlacement; node?: Node }

function buildDir(folders: CatalogFolder[], placements: CatalogPlacement[], nodeById: Map<number, Node>): DirItem[] {
  const folderIds = new Set(folders.map((f) => f.id))
  const childrenOf = new Map<number, CatalogFolder[]>()
  for (const f of folders) {
    const key = f.parent_id != null && folderIds.has(f.parent_id) ? f.parent_id : 0
    const arr = childrenOf.get(key) ?? []
    arr.push(f)
    childrenOf.set(key, arr)
  }
  const plByFolder = new Map<number, CatalogPlacement[]>()
  for (const p of placements) {
    const arr = plByFolder.get(p.folder_id) ?? []
    arr.push(p)
    plByFolder.set(p.folder_id, arr)
  }
  const makeFolder = (f: CatalogFolder): DirItem => {
    const childFolders = (childrenOf.get(f.id) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(makeFolder)
    const assets: DirItem[] = (plByFolder.get(f.id) ?? []).map((p) => ({
      type: "asset",
      id: `asset:${p.id}`,
      placement: p,
      node: nodeById.get(p.node_id),
    }))
    return { type: "folder", id: `folder:${f.id}`, fid: f.id, folder: f, children: [...childFolders, ...assets] }
  }
  return (childrenOf.get(0) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(makeFolder)
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

function StructureTab({
  catalogId,
  folders,
  placements,
  nodes,
  onChanged,
}: {
  catalogId: number
  folders: CatalogFolder[]
  placements: CatalogPlacement[]
  nodes: Node[]
  onChanged: () => void
}) {
  const nodeById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const tree = React.useMemo(() => buildDir(folders, placements, nodeById), [folders, placements, nodeById])

  const [targetFolder, setTargetFolder] = React.useState<number | null>(null)
  const [editing, setEditing] = React.useState<number | null>(null)
  const [editName, setEditName] = React.useState("")

  // Keep a valid target folder selected.
  React.useEffect(() => {
    if (targetFolder != null && !folders.some((f) => f.id === targetFolder)) setTargetFolder(null)
    if (targetFolder == null && folders.length > 0) setTargetFolder(folders[0].id)
  }, [folders, targetFolder])

  const createFolder = useMutation({
    mutationFn: (parent_id: number | null) =>
      catalogService.createFolder(catalogId, { name: "新建文件夹", parent_id }),
    onSuccess: (f) => {
      onChanged()
      setEditing(f.id)
      setEditName(f.name)
    },
    onError: (e: Error) => toast.error("新建文件夹失败", { description: e.message }),
  })
  const renameFolder = useMutation({
    mutationFn: (v: { id: number; name: string }) => catalogService.updateFolder(catalogId, v.id, { name: v.name }),
    onSuccess: () => {
      setEditing(null)
      onChanged()
    },
    onError: (e: Error) => toast.error("重命名失败", { description: e.message }),
  })
  const setFolderIcon = useMutation({
    mutationFn: (v: { id: number; icon: string }) => catalogService.updateFolder(catalogId, v.id, { icon: v.icon }),
    onSuccess: onChanged,
    onError: (e: Error) => toast.error("保存图标失败", { description: e.message }),
  })
  const deleteFolder = useMutation({
    mutationFn: (id: number) => catalogService.removeFolder(catalogId, id),
    onSuccess: onChanged,
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })
  const moveFolder = useMutation({
    mutationFn: (v: { id: number; parent: number | null }) => catalogService.moveFolder(catalogId, v.id, v.parent),
    onSuccess: onChanged,
    onError: (e: Error) => toast.error("移动失败", { description: e.message }),
  })
  const removePlacement = useMutation({
    mutationFn: (pid: number) => catalogService.removePlacement(catalogId, pid),
    onSuccess: onChanged,
    onError: (e: Error) => toast.error("移除失败", { description: e.message }),
  })

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[1fr_320px]">
      {/* Directory tree */}
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-xs font-semibold text-muted-foreground">自定义目录 · 拖拽文件夹可改层级</span>
          <Button variant="outline" size="sm" onClick={() => createFolder.mutate(null)}>
            <FolderPlus className="h-3.5 w-3.5" /> 新建根文件夹
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {tree.length === 0 ? (
            <div className="px-2 py-10 text-center text-xs text-muted-foreground">
              还没有文件夹。先「新建根文件夹」，再把资产加进去。
            </div>
          ) : (
            <TreeList<DirItem>
              key={`${catalogId}:${folders.length}`}
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
                    active={targetFolder === it.fid}
                    editing={editing === it.fid}
                    editName={editName}
                    onPick={() => setTargetFolder(it.fid)}
                    onStartEdit={() => {
                      setEditing(it.fid)
                      setEditName(it.folder.name)
                    }}
                    onEditName={setEditName}
                    onSaveEdit={() => {
                      if (editName.trim()) renameFolder.mutate({ id: it.fid, name: editName.trim() })
                      else setEditing(null)
                    }}
                    onCancelEdit={() => setEditing(null)}
                    onIcon={(icon) => setFolderIcon.mutate({ id: it.fid, icon })}
                    onNewSub={() => createFolder.mutate(it.fid)}
                    onDelete={() => {
                      if (confirm(`删除文件夹「${it.folder.name}」？其子文件夹与资产放置都会一并移除。`))
                        deleteFolder.mutate(it.fid)
                    }}
                  />
                ) : (
                  <AssetRow item={it} onRemove={() => removePlacement.mutate(it.placement.id)} />
                )
              }
            />
          )}
        </div>
      </div>

      {/* Asset library */}
      <AssetLibrary
        nodes={nodes}
        folders={folders}
        targetFolder={targetFolder}
        onTargetFolder={setTargetFolder}
        onAdd={(nodeIds) => {
          if (targetFolder == null) {
            toast.error("先在左侧选择一个目标文件夹")
            return
          }
          catalogService
            .addPlacements(catalogId, targetFolder, nodeIds)
            .then((r) => {
              onChanged()
              toast.success(`已加入 ${r.added} 个资产`)
            })
            .catch((e: Error) => toast.error("加入失败", { description: e.message }))
        }}
      />
    </div>
  )
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
      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{count}</span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover/tree:flex">
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

function AssetRow({ item, onRemove }: { item: Extract<DirItem, { type: "asset" }>; onRemove: () => void }) {
  const n = item.node
  return (
    <div className="flex items-center gap-1.5 py-1 pr-1 text-sm" onClick={(e) => e.stopPropagation()}>
      <AppIcon icon={n?.icon} fallback="lucide:server" size={14} className="shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{n ? n.name : `#${item.placement.node_id}（已删除）`}</span>
      {n && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{n.host}</span>}
      <RowBtn title="从此文件夹移除" onClick={onRemove} danger>
        <X className="h-3.5 w-3.5" />
      </RowBtn>
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

function AssetLibrary({
  nodes,
  folders,
  targetFolder,
  onTargetFolder,
  onAdd,
}: {
  nodes: Node[]
  folders: CatalogFolder[]
  targetFolder: number | null
  onTargetFolder: (id: number) => void
  onAdd: (nodeIds: number[]) => void
}) {
  const [q, setQ] = React.useState("")
  const [checked, setChecked] = React.useState<Set<number>>(new Set())

  const filtered = React.useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return nodes
    return nodes.filter((n) =>
      [n.name, n.host, n.description, n.protocol].filter(Boolean).some((v) => String(v).toLowerCase().includes(k)),
    )
  }, [nodes, q])

  const toggle = (id: number) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }

  // Folder path label, e.g. "核心生产 / 数据库", for the target select.
  const folderLabel = React.useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]))
    return (f: CatalogFolder) => {
      const parts: string[] = []
      let cur: CatalogFolder | undefined = f
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
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 名称 / IP / 协议…"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">目标文件夹</Label>
          <Select
            value={targetFolder != null ? String(targetFolder) : undefined}
            onValueChange={(v) => onTargetFolder(Number(v))}
          >
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
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 p-2">
          {filtered.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs text-muted-foreground">没有匹配的资产</div>
          ) : (
            filtered.map((n) => (
              <label
                key={n.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
              >
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
          disabled={checked.size === 0 || targetFolder == null}
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

// ---------- Assign tab ----------

type ValidMode = "forever" | "7d" | "30d" | "90d" | "custom"
const VALID_PRESETS: { key: ValidMode; label: string }[] = [
  { key: "forever", label: "永久" },
  { key: "7d", label: "7 天" },
  { key: "30d", label: "30 天" },
  { key: "90d", label: "90 天" },
  { key: "custom", label: "自定义" },
]

function computeValidity(mode: ValidMode, from: string, to: string): { from?: string; to?: string; label: string } {
  if (mode === "forever") return { label: "永久有效" }
  if (mode === "custom") {
    const f = from || undefined
    const t = to || undefined
    if (!f && !t) return { label: "永久有效" }
    return { from: f, to: t, label: `${f ? `${f.replace("T", " ")} 起` : "立即生效"} · ${t ? `${t.replace("T", " ")} 到期` : "不过期"}` }
  }
  const days = mode === "7d" ? 7 : mode === "30d" ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() + days)
  const iso = d.toISOString()
  return { to: iso, label: `立即生效 · ${days} 天后到期` }
}

function AssignTab({
  catalogId,
  folders,
  assignments,
  onChanged,
}: {
  catalogId: number
  folders: CatalogFolder[]
  assignments: CatalogAssignment[]
  onChanged: () => void
}) {
  const { granteeCats } = useGrantDirectories()
  const [granteeSel, setGranteeSel] = React.useState<Set<string>>(new Set())
  const [scope, setScope] = React.useState<string>("all") // "all" | folder id
  const [presetKey, setPresetKey] = React.useState("readonly")
  const [validMode, setValidMode] = React.useState<ValidMode>("forever")
  const [validFrom, setValidFrom] = React.useState("")
  const [validTo, setValidTo] = React.useState("")

  const actions = PRESETS.find((p) => p.key === presetKey)?.actions ?? ["connect"]
  const validity = computeValidity(validMode, validFrom, validTo)
  const grantees = [...granteeSel].map(parseRef)
  const validOk = validMode !== "custom" || !!validTo || !!validFrom
  const canSubmit = grantees.length > 0 && actions.length > 0 && validOk

  // Name lookup for rendering existing assignments.
  const granteeName = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const c of granteeCats) for (const it of c.items) m.set(`${c.key}:${it.id}`, it.name)
    return m
  }, [granteeCats])
  const folderName = React.useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders])

  const create = useMutation({
    mutationFn: () =>
      catalogService.createAssignments(catalogId, {
        folder_id: scope === "all" ? null : Number(scope),
        grantees: grantees as { type: GranteeKind; id: number }[],
        actions: actions.join(","),
        valid_from: validity.from,
        valid_to: validity.to,
      }),
    onSuccess: (r) => {
      toast.success("已分配", { description: `新增 ${r.created} 条` })
      setGranteeSel(new Set())
      onChanged()
    },
    onError: (e: Error) => toast.error("分配失败", { description: e.message }),
  })
  const revoke = useMutation({
    mutationFn: (id: number) => catalogService.removeAssignment(catalogId, id),
    onSuccess: onChanged,
    onError: (e: Error) => toast.error("撤销失败", { description: e.message }),
  })

  const GRANTEE_KIND: Record<string, string> = { user: "用户", role: "角色", group: "用户组", department: "部门" }

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[1fr_360px]">
      {/* New assignment */}
      <ScrollArea className="min-h-0 border-r">
        <div className="space-y-5 p-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">分配给谁</Label>
            <MultiPicker cats={granteeCats} selected={granteeSel} onChange={setGranteeSel} />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">分配范围</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="h-9 max-w-sm text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">整个目录</SelectItem>
                {folders.map((f) => (
                  <SelectItem key={f.id} value={String(f.id)}>
                    仅文件夹：{f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">授予什么权限</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPresetKey(p.key)}
                  title={p.desc}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm transition-colors",
                    presetKey === p.key ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {actions.map((a) => (
                <Badge key={a} variant="outline" className="font-normal">
                  {actionLabel(a)}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">有效期</Label>
            <div className="flex flex-wrap gap-1.5">
              {VALID_PRESETS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setValidMode(v.key)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm transition-colors",
                    validMode === v.key ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {validMode === "custom" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">生效起始（留空＝立即）</Label>
                  <Input type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">到期（留空＝不过期）</Label>
                  <Input type="datetime-local" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
                </div>
              </div>
            )}
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" /> {validity.label}
            </p>
          </div>

          <Button disabled={!canSubmit || create.isPending} onClick={() => create.mutate()}>
            <Check className="h-4 w-4" /> 确认分配{grantees.length > 1 ? ` · ${grantees.length}` : ""}
          </Button>
        </div>
      </ScrollArea>

      {/* Existing assignments */}
      <div className="flex min-h-0 flex-col">
        <div className="shrink-0 border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
          已分配 · {assignments.length}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 p-3">
            {assignments.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-muted-foreground">还没有分配</div>
            ) : (
              assignments.map((a) => (
                <div key={a.id} className="rounded-lg border p-2.5 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className="font-normal">
                          {GRANTEE_KIND[a.grantee_type] ?? a.grantee_type}
                        </Badge>
                        <span className="truncate font-medium">
                          {granteeName.get(`${a.grantee_type}:${a.grantee_id}`) ?? `#${a.grantee_id}`}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {a.folder_id ? `仅文件夹：${folderName.get(a.folder_id) ?? `#${a.folder_id}`}` : "整个目录"}
                        {" · "}
                        {summarizeActions(a.actions.split(",").filter(Boolean))}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {a.valid_to ? `到期 ${new Date(a.valid_to).toLocaleString()}` : "永久有效"}
                      </div>
                    </div>
                    <RowBtn title="撤销" onClick={() => revoke.mutate(a.id)} danger>
                      <Trash2 className="h-3.5 w-3.5" />
                    </RowBtn>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
