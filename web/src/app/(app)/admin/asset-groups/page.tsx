"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Server,
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
import { AppIcon } from "@/components/icons/app-icon"
import { GroupMembersSheet } from "@/components/admin/group-members-sheet"
import { assetGroupService } from "@/lib/api/services"
import type { AssetGroup } from "@/lib/api/types"

type GNode = AssetGroup & { children: GNode[] }

const GROUPS_KEY = ["admin", "asset-groups"] as const

export default function AssetGroupsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: GROUPS_KEY, queryFn: assetGroupService.list })
  const groups = React.useMemo(() => list.data?.asset_groups ?? [], [list.data])

  const [q, setQ] = React.useState("")
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [createParent, setCreateParent] = React.useState<number | null | undefined>(undefined)
  const [editing, setEditing] = React.useState<AssetGroup | null>(null)
  const [memberGroup, setMemberGroup] = React.useState<AssetGroup | null>(null)
  const [renamingId, setRenamingId] = React.useState<number | null>(null)

  const refresh = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: GROUPS_KEY })
    qc.invalidateQueries({ queryKey: ["asset-groups"] }) // workspace tree
    qc.invalidateQueries({ queryKey: ["nodes"] })
  }, [qc])

  const byId = React.useMemo(() => {
    const m = new Map<number, AssetGroup>()
    for (const g of groups) m.set(g.id, g)
    return m
  }, [groups])

  // Unique member count over a group's whole subtree (a node can sit in several
  // sub-groups; we de-dupe).
  const subtreeCount = React.useMemo(() => {
    const childrenOf = new Map<number, AssetGroup[]>()
    for (const g of groups) {
      const p = g.parent_id ?? 0
      const arr = childrenOf.get(p) ?? []
      arr.push(g)
      childrenOf.set(p, arr)
    }
    const cache = new Map<number, Set<number>>()
    const compute = (g: AssetGroup): Set<number> => {
      const cached = cache.get(g.id)
      if (cached) return cached
      const set = new Set<number>(g.node_ids ?? [])
      for (const c of childrenOf.get(g.id) ?? []) {
        for (const id of compute(c)) set.add(id)
      }
      cache.set(g.id, set)
      return set
    }
    const out = new Map<number, number>()
    for (const g of groups) out.set(g.id, compute(g).size)
    return out
  }, [groups])

  // Build the forest (roots = no parent or a parent that no longer exists).
  const fullTree = React.useMemo(() => buildTree(groups, byId), [groups, byId])

  // Search: keep matches + their ancestors + their subtrees; auto-expand them.
  const query = q.trim().toLowerCase()
  const { tree, searchExpanded } = React.useMemo(() => {
    if (!query) return { tree: fullTree, searchExpanded: null as Set<string> | null }
    const keep = new Set<number>()
    const addSubtree = (g: AssetGroup) => {
      keep.add(g.id)
      for (const c of groups.filter((x) => x.parent_id === g.id)) addSubtree(c)
    }
    for (const g of groups) {
      if (g.name.toLowerCase().includes(query) || (g.description ?? "").toLowerCase().includes(query)) {
        addSubtree(g)
        let cur: AssetGroup | undefined = g
        while (cur) {
          keep.add(cur.id)
          cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined
        }
      }
    }
    const kept = groups.filter((g) => keep.has(g.id))
    return {
      tree: buildTree(kept, byId),
      searchExpanded: new Set([...keep].map(String)),
    }
  }, [query, fullTree, groups, byId])

  const allParentIds = React.useMemo(
    () => groups.filter((g) => groups.some((c) => c.parent_id === g.id)).map((g) => String(g.id)),
    [groups],
  )

  const create = useMutation({
    mutationFn: (body: { name: string; parent_id: number | null; description?: string }) =>
      assetGroupService.create(body as Partial<AssetGroup>),
    onSuccess: (_d, vars) => {
      setCreateParent(undefined)
      if (vars.parent_id != null) setExpanded((s) => new Set(s).add(String(vars.parent_id)))
      refresh()
      toast.success("已创建资产组")
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  const update = useMutation({
    mutationFn: (body: { id: number; name: string; description?: string }) =>
      assetGroupService.update(body.id, { name: body.name, description: body.description }),
    onSuccess: () => {
      setEditing(null)
      setRenamingId(null)
      refresh()
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  const move = useMutation({
    mutationFn: ({ id, parent }: { id: number; parent: number | null }) =>
      assetGroupService.move(id, parent),
    onSuccess: () => {
      refresh()
      toast.success("已移动")
    },
    onError: (e: unknown) => toast.error("移动失败", { description: (e as Error).message }),
  })

  const remove = useMutation({
    mutationFn: (id: number) => assetGroupService.remove(id),
    onSuccess: () => {
      refresh()
      toast.success("已删除（子组已上提一级）")
    },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })

  function commitRename(g: AssetGroup, name: string) {
    const t = name.trim()
    if (!t || t === g.name) {
      setRenamingId(null)
      return
    }
    update.mutate({ id: g.id, name: t, description: g.description })
  }

  async function askDelete(g: AssetGroup) {
    const ok = await confirmDialog({
      title: `删除资产组「${g.name}」？`,
      description: "组内节点不会被删除，只解除分组；它的直接子组会自动上提到上一级。",
      destructive: true,
    })
    if (ok) remove.mutate(g.id)
  }

  const isEmpty = !list.isLoading && groups.length === 0

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FolderTree className="h-5 w-5 text-primary" /> 资产组
          </h1>
          <p className="text-sm text-muted-foreground">
            用树形结构组织资产，支持拖拽改父级、按组授权。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setExpanded(new Set(allParentIds))} title="展开全部">
            <ChevronsUpDown className="h-4 w-4" /> 展开
          </Button>
          <Button variant="outline" size="sm" onClick={() => setExpanded(new Set())} title="折叠全部">
            <ChevronsDownUp className="h-4 w-4" /> 折叠
          </Button>
          <Button onClick={() => setCreateParent(null)}>
            <FolderPlus className="h-4 w-4" /> 新建顶级组
          </Button>
        </div>
      </div>

      {!isEmpty && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索资产组…" className="pl-9" />
        </div>
      )}

      {isEmpty ? (
        <EmptyState
          icon={FolderTree}
          title="还没有资产组"
          description="创建第一个资产组，开始用树形结构组织你的资产。"
          action={
            <Button onClick={() => setCreateParent(null)}>
              <FolderPlus className="h-4 w-4" /> 新建资产组
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border border-border bg-card p-2">
          <TreeList<GNode>
            nodes={tree}
            getId={(g) => String(g.id)}
            getChildren={(g) => g.children}
            expandedIds={searchExpanded ?? expanded}
            onExpandedChange={setExpanded}
            onMove={(sourceId, targetId) =>
              move.mutate({ id: Number(sourceId), parent: targetId == null ? null : Number(targetId) })
            }
            canDrag={(g) => renamingId !== g.id}
            rootDropLabel="拖到这里 → 移到顶层"
            onActivate={(g) => setMemberGroup(g)}
            emptyHint={
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有匹配的资产组</div>
            }
            renderRow={(g) => (
              <div className="flex items-center gap-1.5 py-1 pr-1">
                <AppIcon icon="lucide:folder" size={15} className="shrink-0 text-muted-foreground" />
                {renamingId === g.id ? (
                  <input
                    autoFocus
                    defaultValue={g.name}
                    onBlur={(e) => commitRename(g, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(g, (e.target as HTMLInputElement).value)
                      if (e.key === "Escape") setRenamingId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  />
                ) : (
                  <span
                    className="truncate font-medium"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenamingId(g.id)
                    }}
                  >
                    {g.name}
                  </span>
                )}
                <MemberCount direct={g.node_ids?.length ?? 0} subtree={subtreeCount.get(g.id) ?? 0} />
                <span className="flex-1" />
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/tree:opacity-100">
                  <IconBtn title="新建子组" onClick={() => setCreateParent(g.id)}>
                    <Plus className="h-3.5 w-3.5" />
                  </IconBtn>
                  <IconBtn title="管理成员" onClick={() => setMemberGroup(g)}>
                    <Users className="h-3.5 w-3.5" />
                  </IconBtn>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                        title="更多"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRenamingId(g.id)}>
                        <Pencil className="h-4 w-4" /> 重命名
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setEditing(g)}>
                        <Pencil className="h-4 w-4" /> 编辑描述
                      </DropdownMenuItem>
                      {g.parent_id != null && (
                        <DropdownMenuItem onSelect={() => move.mutate({ id: g.id, parent: null })}>
                          <FolderTree className="h-4 w-4" /> 移到顶层
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => askDelete(g)}
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

      <CreateDialog
        open={createParent !== undefined}
        parentName={createParent != null ? byId.get(createParent)?.name : undefined}
        pending={create.isPending}
        onClose={() => setCreateParent(undefined)}
        onCreate={(name, description) =>
          create.mutate({ name, parent_id: createParent ?? null, description })
        }
      />

      <EditDialog
        group={editing}
        pending={update.isPending}
        onClose={() => setEditing(null)}
        onSave={(name, description) => editing && update.mutate({ id: editing.id, name, description })}
      />

      <GroupMembersSheet group={memberGroup} onClose={() => setMemberGroup(null)} onChanged={refresh} />
    </div>
  )
}

// ----- helpers -----

function buildTree(groups: AssetGroup[], byId: Map<number, AssetGroup>): GNode[] {
  const nodes = new Map<number, GNode>()
  for (const g of groups) nodes.set(g.id, { ...g, children: [] })
  const roots: GNode[] = []
  for (const g of groups) {
    const node = nodes.get(g.id)!
    const parent = g.parent_id != null ? nodes.get(g.parent_id) : undefined
    // A group whose parent is filtered out (search) or missing becomes a root.
    if (parent && byId.has(g.parent_id!)) parent.children.push(node)
    else roots.push(node)
  }
  const sortRec = (arr: GNode[]) => {
    arr.sort((a, b) => a.name.localeCompare(b.name))
    for (const n of arr) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

function MemberCount({ direct, subtree }: { direct: number; subtree: number }) {
  const extra = subtree - direct
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"
      title={extra > 0 ? `直接 ${direct} · 含子组 ${subtree}` : `${direct} 个成员`}
    >
      <Server className="h-3 w-3" />
      {direct}
      {extra > 0 && <span className="text-muted-foreground/70">(+{extra})</span>}
    </span>
  )
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
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

function CreateDialog({
  open,
  parentName,
  pending,
  onClose,
  onCreate,
}: {
  open: boolean
  parentName?: string
  pending: boolean
  onClose: () => void
  onCreate: (name: string, description?: string) => void
}) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  React.useEffect(() => {
    if (open) {
      setName("")
      setDescription("")
    }
  }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{parentName ? `在「${parentName}」下新建子组` : "新建顶级资产组"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>名称</Label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 生产环境 / 华东机房"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) onCreate(name.trim(), description.trim() || undefined)
              }}
            />
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
          <Button
            disabled={!name.trim() || pending}
            onClick={() => onCreate(name.trim(), description.trim() || undefined)}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditDialog({
  group,
  pending,
  onClose,
  onSave,
}: {
  group: AssetGroup | null
  pending: boolean
  onClose: () => void
  onSave: (name: string, description?: string) => void
}) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  React.useEffect(() => {
    if (group) {
      setName(group.name)
      setDescription(group.description ?? "")
    }
  }, [group])
  return (
    <Dialog open={!!group} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑资产组</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>描述</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[80px] resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!name.trim() || pending} onClick={() => onSave(name.trim(), description.trim() || undefined)}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
