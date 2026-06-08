"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Building2,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { TreeList } from "@/components/common/tree-list"
import { BatchActionBar } from "@/components/common/batch-action-bar"
import { AppIcon } from "@/components/icons/app-icon"
import { IconPicker } from "@/components/icons/icon-picker"
import { OrgDetailPanel, type OrgEntity, type OrgKind } from "@/components/admin/org-detail-panel"
import { departmentService, groupService } from "@/lib/api/services"
import type { Department, UserGroup } from "@/lib/api/types"
import { cn } from "@/lib/utils"

type OrgNode = OrgEntity & { children: OrgNode[] }
type CreateBody = { name: string; parent_id: number | null; description?: string; icon?: string }
type UpdateBody = { name: string; description?: string; icon?: string }

interface KindMeta {
  noun: string
  defaultIcon: string
  queryKey: readonly unknown[]
  listFn: () => Promise<OrgEntity[]>
  create: (b: CreateBody) => Promise<unknown>
  update: (id: number, b: UpdateBody) => Promise<unknown>
  move: (id: number, parent: number | null) => Promise<unknown>
  remove: (id: number) => Promise<unknown>
}

const META: Record<OrgKind, KindMeta> = {
  department: {
    noun: "部门",
    defaultIcon: "lucide:building-2",
    // Distinct from the ["admin","depts"] / ["admin","groups"] keys used by the
    // grant-wizard & asset-grants page, whose queryFns return the raw
    // {departments|groups} OBJECT (not the array) — sharing a key would let an
    // object overwrite our array in the cache ("entities is not iterable").
    queryKey: ["admin", "org", "departments"],
    listFn: async () => ((await departmentService.list()).departments ?? []) as OrgEntity[],
    create: (b) => departmentService.create(b as Partial<Department>),
    update: (id, b) => departmentService.update(id, b as Partial<Department>),
    move: (id, p) => departmentService.move(id, p),
    remove: (id) => departmentService.remove(id),
  },
  group: {
    noun: "用户组",
    defaultIcon: "lucide:users",
    queryKey: ["admin", "org", "groups"],
    listFn: async () => ((await groupService.list()).groups ?? []) as OrgEntity[],
    create: (b) => groupService.create(b as Partial<UserGroup>),
    update: (id, b) => groupService.update(id, b as Partial<UserGroup>),
    move: (id, p) => groupService.move(id, p),
    remove: (id) => groupService.remove(id),
  },
}

const TABS: { kind: OrgKind; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { kind: "department", label: "部门", icon: Building2 },
  { kind: "group", label: "用户组", icon: Users },
]

export default function OrganizationPage() {
  const qc = useQueryClient()
  const [kind, setKind] = React.useState<OrgKind>("department")
  const meta = META[kind]

  const [q, setQ] = React.useState("")
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = React.useState<number | null>(null)
  const [createParent, setCreateParent] = React.useState<number | null | undefined>(undefined)
  const [editing, setEditing] = React.useState<OrgEntity | null>(null)
  const [renamingId, setRenamingId] = React.useState<number | null>(null)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set())

  function switchKind(next: OrgKind) {
    setKind(next)
    setQ("")
    setExpanded(new Set())
    setSelectedId(null)
    setRenamingId(null)
    setSelectedIds(new Set())
  }

  const list = useQuery({ queryKey: meta.queryKey, queryFn: meta.listFn })
  // Guard against a non-array landing in the cache (stale shape / key collision):
  // a non-iterable here would crash the byId/tree memos.
  const entities = React.useMemo<OrgEntity[]>(
    () => (Array.isArray(list.data) ? list.data : []),
    [list.data],
  )

  const byId = React.useMemo(() => {
    const m = new Map<number, OrgEntity>()
    for (const e of entities) m.set(e.id, e)
    return m
  }, [entities])

  // De-duplicated member count over an entity's whole subtree.
  const subtreeCount = React.useMemo(() => {
    const childrenOf = new Map<number, OrgEntity[]>()
    for (const e of entities) {
      const p = e.parent_id ?? 0
      const arr = childrenOf.get(p) ?? []
      arr.push(e)
      childrenOf.set(p, arr)
    }
    const cache = new Map<number, Set<number>>()
    const compute = (e: OrgEntity): Set<number> => {
      const cached = cache.get(e.id)
      if (cached) return cached
      const set = new Set<number>(e.member_ids ?? [])
      for (const c of childrenOf.get(e.id) ?? []) for (const id of compute(c)) set.add(id)
      cache.set(e.id, set)
      return set
    }
    const out = new Map<number, number>()
    for (const e of entities) out.set(e.id, compute(e).size)
    return out
  }, [entities])

  const fullTree = React.useMemo(() => buildTree(entities, byId), [entities, byId])

  const query = q.trim().toLowerCase()
  const { tree, searchExpanded } = React.useMemo(() => {
    if (!query) return { tree: fullTree, searchExpanded: null as Set<string> | null }
    const keep = new Set<number>()
    const addSubtree = (e: OrgEntity) => {
      keep.add(e.id)
      for (const c of entities.filter((x) => x.parent_id === e.id)) addSubtree(c)
    }
    for (const e of entities) {
      if (e.name.toLowerCase().includes(query) || (e.description ?? "").toLowerCase().includes(query)) {
        addSubtree(e)
        let cur: OrgEntity | undefined = e
        while (cur) {
          keep.add(cur.id)
          cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined
        }
      }
    }
    const kept = entities.filter((e) => keep.has(e.id))
    return { tree: buildTree(kept, byId), searchExpanded: new Set([...keep].map(String)) }
  }, [query, fullTree, entities, byId])

  const allParentIds = React.useMemo(
    () => entities.filter((e) => entities.some((c) => c.parent_id === e.id)).map((e) => String(e.id)),
    [entities],
  )

  const selected = selectedId != null ? byId.get(selectedId) ?? null : null
  const breadcrumb = React.useMemo(() => {
    if (!selected) return []
    const names: string[] = []
    let cur: OrgEntity | undefined = selected
    const guard = new Set<number>()
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id)
      names.unshift(cur.name)
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined
    }
    return names
  }, [selected, byId])

  const refresh = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: meta.queryKey })
    // Other consumers of the org directories (grant wizard, asset-grants page,
    // users page) and the user→department display all need to refresh too.
    qc.invalidateQueries({ queryKey: ["admin", "groups"] })
    qc.invalidateQueries({ queryKey: ["admin", "depts"] })
    qc.invalidateQueries({ queryKey: ["admin", "users"] })
    qc.invalidateQueries({ queryKey: ["admin", "access"] })
  }, [qc, meta.queryKey])

  const create = useMutation({
    mutationFn: (body: CreateBody) => meta.create(body),
    onSuccess: (_d, vars) => {
      setCreateParent(undefined)
      if (vars.parent_id != null) setExpanded((s) => new Set(s).add(String(vars.parent_id)))
      refresh()
      toast.success(`已创建${meta.noun}`)
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateBody }) => meta.update(id, body),
    onSuccess: () => {
      setEditing(null)
      setRenamingId(null)
      refresh()
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  const move = useMutation({
    mutationFn: ({ id, parent }: { id: number; parent: number | null }) => meta.move(id, parent),
    onSuccess: () => {
      refresh()
      toast.success("已移动")
    },
    onError: (e: unknown) => toast.error("移动失败", { description: (e as Error).message }),
  })

  const remove = useMutation({
    mutationFn: (id: number) => meta.remove(id),
    onSuccess: (_d, id) => {
      if (selectedId === id) setSelectedId(null)
      refresh()
      toast.success(`已删除（子${meta.noun}已上提一级）`)
    },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })

  const selectedEntityIds = React.useMemo(() => [...selectedIds].map(Number), [selectedIds])
  const bulkMoveTop = useMutation({
    mutationFn: () => Promise.all(selectedEntityIds.map((id) => meta.move(id, null))),
    onSuccess: () => { setSelectedIds(new Set()); refresh(); toast.success("已移到顶层") },
    onError: (e: unknown) => toast.error("移动失败", { description: (e as Error).message }),
  })
  const bulkRemove = useMutation({
    mutationFn: () => Promise.all(selectedEntityIds.map((id) => meta.remove(id))),
    onSuccess: () => { setSelectedIds(new Set()); setSelectedId(null); refresh(); toast.success(`已删除所选${meta.noun}（子级上提一级）`) },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })
  async function askBulkDelete() {
    const ok = await confirmDialog({
      title: `删除所选 ${selectedEntityIds.length} 个${meta.noun}？`,
      description: `成员关系会一并解除，它们的直接子${meta.noun}会自动上提一级。`,
      destructive: true,
    })
    if (ok) bulkRemove.mutate()
  }

  function commitRename(e: OrgEntity, name: string) {
    const t = name.trim()
    if (!t || t === e.name) {
      setRenamingId(null)
      return
    }
    update.mutate({ id: e.id, body: { name: t, description: e.description, icon: e.icon } })
  }

  async function askDelete(e: OrgEntity) {
    const ok = await confirmDialog({
      title: `删除${meta.noun}「${e.name}」？`,
      description: `成员关系会解除（用户不会被删除）；它的直接子${meta.noun}会自动上提到上一级。`,
      destructive: true,
    })
    if (ok) remove.mutate(e.id)
  }

  const isEmpty = !list.isLoading && entities.length === 0

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FolderTree className="h-5 w-5 text-primary" /> 组织架构
          </h1>
          <p className="text-sm text-muted-foreground">
            统一管理部门与用户组：树形结构、拖拽改父级、多部门归属，授权沿树向下继承。
          </p>
        </div>
        {/* Tab switch */}
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {TABS.map((t) => {
            const active = kind === t.kind
            return (
              <button
                key={t.kind}
                type="button"
                onClick={() => switchKind(t.kind)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        {/* Left: tree */}
        <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border p-2.5">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={`搜索${meta.noun}…`}
                className="h-9 pl-8"
              />
            </div>
            <Button variant="ghost" size="icon" className="h-9 w-9" title="展开全部" onClick={() => setExpanded(new Set(allParentIds))}>
              <ChevronsUpDown className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9" title="折叠全部" onClick={() => setExpanded(new Set())}>
              <ChevronsDownUp className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => setCreateParent(null)}>
              <Plus className="h-4 w-4" /> 新建
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {isEmpty ? (
              <EmptyState
                icon={kind === "department" ? Building2 : Users}
                title={`还没有${meta.noun}`}
                description={`创建第一个${meta.noun}，开始用树形结构组织你的团队。`}
                action={
                  <Button onClick={() => setCreateParent(null)}>
                    <Plus className="h-4 w-4" /> 新建{meta.noun}
                  </Button>
                }
              />
            ) : (
              <div className="space-y-2">
              {selectedEntityIds.length > 0 && (
                <BatchActionBar count={selectedEntityIds.length} noun={meta.noun} onClear={() => setSelectedIds(new Set())}>
                  <Button
                    variant="outline" size="sm" className="h-7 gap-1"
                    disabled={bulkMoveTop.isPending}
                    onClick={() => bulkMoveTop.mutate()}
                  >
                    <FolderTree className="h-3.5 w-3.5" /> 移到顶层
                  </Button>
                  <Button
                    variant="outline" size="sm" className="h-7 gap-1 text-destructive hover:text-destructive"
                    disabled={bulkRemove.isPending}
                    onClick={askBulkDelete}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> 删除
                  </Button>
                </BatchActionBar>
              )}
              <TreeList<OrgNode>
                nodes={tree}
                getId={(e) => String(e.id)}
                getChildren={(e) => e.children}
                expandedIds={searchExpanded ?? expanded}
                onExpandedChange={setExpanded}
                selectable
                selectedIds={selectedIds}
                onSelectedChange={setSelectedIds}
                onMove={(sourceId, targetId) =>
                  move.mutate({ id: Number(sourceId), parent: targetId == null ? null : Number(targetId) })
                }
                canDrag={(e) => renamingId !== e.id}
                rootDropLabel="拖到这里 → 移到顶层"
                onActivate={(e) => setSelectedId(e.id)}
                emptyHint={<div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的{meta.noun}</div>}
                rowClassName={(e) => (selectedId === e.id ? "bg-primary/[0.07] ring-1 ring-primary/30" : "")}
                renderRow={(e) => (
                  <div
                    className="flex items-center gap-1.5 py-1 pr-1"
                    onClick={() => setSelectedId(e.id)}
                  >
                    <AppIcon
                      icon={e.icon || meta.defaultIcon}
                      size={15}
                      className="shrink-0 text-muted-foreground"
                    />
                    {renamingId === e.id ? (
                      <input
                        autoFocus
                        defaultValue={e.name}
                        onBlur={(ev) => commitRename(e, ev.target.value)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter") commitRename(e, (ev.target as HTMLInputElement).value)
                          if (ev.key === "Escape") setRenamingId(null)
                        }}
                        onClick={(ev) => ev.stopPropagation()}
                        className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      />
                    ) : (
                      <span className="truncate text-sm font-medium">{e.name}</span>
                    )}
                    <MemberCount
                      direct={e.member_ids?.length ?? 0}
                      subtree={subtreeCount.get(e.id) ?? 0}
                    />
                    <span className="flex-1" />
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/tree:opacity-100">
                      <IconBtn title={`新建子${meta.noun}`} onClick={() => setCreateParent(e.id)}>
                        <Plus className="h-3.5 w-3.5" />
                      </IconBtn>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            onClick={(ev) => ev.stopPropagation()}
                            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                            title="更多"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setRenamingId(e.id)}>
                            <Pencil className="h-4 w-4" /> 重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setEditing(e)}>
                            <Pencil className="h-4 w-4" /> 编辑详情
                          </DropdownMenuItem>
                          {e.parent_id != null && (
                            <DropdownMenuItem onSelect={() => move.mutate({ id: e.id, parent: null })}>
                              <FolderTree className="h-4 w-4" /> 移到顶层
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => askDelete(e)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                )}
              />
              </div>
            )}
          </div>
        </div>

        {/* Right: detail */}
        <div className="min-h-0 rounded-xl border border-border bg-card">
          {selected ? (
            <OrgDetailPanel
              key={`${kind}:${selected.id}`}
              kind={kind}
              entity={selected}
              breadcrumb={breadcrumb}
              subtreeMemberCount={subtreeCount.get(selected.id) ?? selected.member_ids?.length ?? 0}
              onEdit={() => setEditing(selected)}
              onChanged={refresh}
            />
          ) : (
            <div className="grid h-full place-items-center p-6">
              <EmptyState
                icon={kind === "department" ? Building2 : Users}
                title={`选择一个${meta.noun}`}
                description={`在左侧点选${meta.noun}，即可在这里管理成员、查看继承的资产授权。`}
              />
            </div>
          )}
        </div>
      </div>

      <EntityDialog
        open={createParent !== undefined}
        title={
          createParent != null
            ? `在「${byId.get(createParent)?.name ?? ""}」下新建子${meta.noun}`
            : `新建顶级${meta.noun}`
        }
        noun={meta.noun}
        defaultIcon={meta.defaultIcon}
        pending={create.isPending}
        onClose={() => setCreateParent(undefined)}
        onSubmit={(v) => create.mutate({ name: v.name, parent_id: createParent ?? null, description: v.description, icon: v.icon })}
      />

      <EntityDialog
        open={!!editing}
        title={`编辑${meta.noun}`}
        noun={meta.noun}
        defaultIcon={meta.defaultIcon}
        initial={editing ?? undefined}
        pending={update.isPending}
        onClose={() => setEditing(null)}
        onSubmit={(v) => editing && update.mutate({ id: editing.id, body: { name: v.name, description: v.description, icon: v.icon } })}
      />
    </div>
  )
}

// ----- helpers -----

function buildTree(items: OrgEntity[], byId: Map<number, OrgEntity>): OrgNode[] {
  const nodes = new Map<number, OrgNode>()
  for (const e of items) nodes.set(e.id, { ...e, children: [] })
  const roots: OrgNode[] = []
  for (const e of items) {
    const node = nodes.get(e.id)!
    const parent = e.parent_id != null ? nodes.get(e.parent_id) : undefined
    if (parent && byId.has(e.parent_id!)) parent.children.push(node)
    else roots.push(node)
  }
  const sortRec = (arr: OrgNode[]) => {
    arr.sort((a, b) => (a.order_idx ?? 0) - (b.order_idx ?? 0) || a.name.localeCompare(b.name))
    for (const n of arr) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

function MemberCount({ direct, subtree }: { direct: number; subtree: number }) {
  const extra = subtree - direct
  return (
    <span
      className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"
      title={extra > 0 ? `直接 ${direct} · 含子级 ${subtree}` : `${direct} 个成员`}
    >
      <Users className="h-3 w-3" />
      {direct}
      {extra > 0 && <span className="text-muted-foreground/70">(+{extra})</span>}
    </span>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
    >
      {children}
    </button>
  )
}

function EntityDialog({
  open,
  title,
  noun,
  defaultIcon,
  initial,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  noun: string
  defaultIcon: string
  initial?: OrgEntity
  pending: boolean
  onClose: () => void
  onSubmit: (v: { name: string; description?: string; icon?: string }) => void
}) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [icon, setIcon] = React.useState<string>(defaultIcon)
  React.useEffect(() => {
    if (open) {
      setName(initial?.name ?? "")
      setDescription(initial?.description ?? "")
      setIcon(initial?.icon || defaultIcon)
    }
  }, [open, initial, defaultIcon])

  function submit() {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), description: description.trim() || undefined, icon: icon || undefined })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>名称</Label>
            <div className="flex items-center gap-2">
              <IconPicker
                value={icon}
                onChange={setIcon}
                trigger={
                  <button
                    type="button"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-input bg-background hover:bg-accent"
                    title="选择图标"
                  >
                    <AppIcon icon={icon || defaultIcon} size={18} />
                  </button>
                }
              />
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`如 ${noun === "部门" ? "研发中心 / 后端组" : "运维组 / DBA"}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit()
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>描述（可选）</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[60px] resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || pending} onClick={submit}>
            {initial ? "保存" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
