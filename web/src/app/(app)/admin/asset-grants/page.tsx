"use client"

// 访问策略中心 —— 把零散的「一条条建授权」重做成一个能回答“谁能访问什么”的工作台：
//   · 总览：所有授权，人话权限标签 + 有效期 + 搜索 + 撤销
//   · 按人看：选一个人/组/角色，穿透解析他实际能进的资产 + 来源
//   · 按资产看：选一台资产，看谁能进、经由什么、何时到期，可直接撤销
//   · 授权向导：选资产 × 选人 × 选权限套餐 × 有效期 → 预览 → 一次批量授权

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  ChevronsUpDown,
  FileLock2,
  Layers,
  Search,
  ShieldCheck,
  Tag as TagIcon,
  Trash2,
  User as UserIcon,
  Users,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { GrantWizard } from "@/components/admin/grant-wizard"
import { TreeList } from "@/components/common/tree-list"
import { AppIcon } from "@/components/icons/app-icon"
import { BatchActionBar } from "@/components/common/batch-action-bar"
import { NodeBatchActions } from "@/components/asset-tree/node-batch-actions"
import { NodeDetailPanel } from "@/components/asset-tree/node-detail"
import { buildAccessTree, childrenOfRow, collectGroupRowIds, type AccessTreeRow } from "@/lib/asset-tree/build"
import {
  ActionChips,
  ValidityCell,
  GRANTEE_KIND_LABEL,
  VIA_LABEL,
  granteeNameFrom,
} from "@/lib/access/grant-display"
import { nodeIcon } from "@/lib/icons/protocol"
import {
  assetGroupService, departmentService, grantService, groupService, nodeService, roleService, tagService, userService,
} from "@/lib/api/services"
import type { AssetGrant, AssetGroup, GranteeKind, Node } from "@/lib/api/types"

// ---- 公共：实体目录（供选择器与名称解析复用） ----------------------------

interface Entity {
  id: number
  name: string
  sub?: string
}
type Catalog = Record<string, Map<number, Entity>>

function useDirectories() {
  const users = useQuery({ queryKey: ["admin", "users", "all"], queryFn: () => userService.list({ limit: 1000 }) })
  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: roleService.list })
  const groups = useQuery({ queryKey: ["admin", "groups"], queryFn: groupService.list })
  const depts = useQuery({ queryKey: ["admin", "depts"], queryFn: departmentService.list })
  const nodes = useQuery({ queryKey: ["admin", "nodes"], queryFn: nodeService.list })
  const assetGroups = useQuery({ queryKey: ["admin", "asset-groups"], queryFn: assetGroupService.list })
  const tags = useQuery({ queryKey: ["admin", "tags"], queryFn: tagService.list })

  const granteeCats = React.useMemo(
    () => [
      { key: "user" as const, label: "用户", icon: UserIcon, items: (users.data?.users || []).map((u) => ({ id: u.id, name: u.username })) },
      { key: "role" as const, label: "角色", icon: ShieldCheck, items: (roles.data?.roles || []).map((r) => ({ id: r.id, name: r.name })) },
      { key: "group" as const, label: "用户组", icon: Users, items: (groups.data?.groups || []).map((g) => ({ id: g.id, name: g.name })) },
      { key: "department" as const, label: "部门", icon: Layers, items: (depts.data?.departments || []).map((d) => ({ id: d.id, name: d.name, sub: d.path })) },
    ],
    [users.data, roles.data, groups.data, depts.data],
  )
  const subjectCats = React.useMemo(
    () => [
      { key: "node" as const, label: "节点", icon: ChevronsUpDown, items: (nodes.data?.nodes || []).map((n) => ({ id: n.id, name: n.name, sub: `${n.host}:${n.port}` })) },
      { key: "group" as const, label: "资产组", icon: Layers, items: (assetGroups.data?.asset_groups || []).map((g) => ({ id: g.id, name: g.name, sub: g.path })) },
      { key: "tag" as const, label: "标签", icon: TagIcon, items: (tags.data?.tags || []).map((t) => ({ id: t.id, name: t.name })) },
    ],
    [nodes.data, assetGroups.data, tags.data],
  )

  const granteeCat: Catalog = React.useMemo(() => indexCats(granteeCats), [granteeCats])
  const subjectCat: Catalog = React.useMemo(() => indexCats(subjectCats), [subjectCats])

  return { granteeCats, subjectCats, granteeCat, subjectCat, nodes, assetGroups, tags }
}

function indexCats(cats: { key: string; items: Entity[] }[]): Catalog {
  const out: Catalog = {}
  for (const c of cats) out[c.key] = new Map(c.items.map((i) => [i.id, i]))
  return out
}

function granteeName(cat: Catalog, type: GranteeKind, id: number): string {
  return cat[type]?.get(id)?.name ?? `${GRANTEE_KIND_LABEL[type]}#${id}`
}

// ---- 主页 ------------------------------------------------------------------

export default function AccessPolicyPage() {
  const qc = useQueryClient()
  const dirs = useDirectories()

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FileLock2 className="h-5 w-5" /> 访问策略
          </h1>
          <p className="text-sm text-muted-foreground">谁能访问哪些资产、能做什么、到什么时候 —— 都在这里管。</p>
        </div>
        <GrantWizard onDone={() => qc.invalidateQueries({ queryKey: ["admin", "grants"] })} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">总览</TabsTrigger>
          <TabsTrigger value="by-grantee">按人看</TabsTrigger>
          <TabsTrigger value="by-subject">按资产看</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab granteeCat={dirs.granteeCat} subjectCat={dirs.subjectCat} />
        </TabsContent>
        <TabsContent value="by-grantee" className="mt-4">
          <ByGranteeTab
            granteeCats={dirs.granteeCats}
            granteeCat={dirs.granteeCat}
            nodes={dirs.nodes.data?.nodes ?? []}
            assetGroups={dirs.assetGroups.data?.asset_groups ?? []}
            tags={dirs.tags.data?.tags ?? []}
            onChanged={() => qc.invalidateQueries({ queryKey: ["access", "by-grantee"] })}
          />
        </TabsContent>
        <TabsContent value="by-subject" className="mt-4">
          <BySubjectTab subjectCat={dirs.subjectCat} granteeCat={dirs.granteeCat} onChanged={() => qc.invalidateQueries({ queryKey: ["admin", "grants"] })} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---- 总览 ------------------------------------------------------------------

function OverviewTab({ granteeCat, subjectCat }: { granteeCat: Catalog; subjectCat: Catalog }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "grants"], queryFn: grantService.list })
  const [q, setQ] = React.useState("")
  const remove = useMutation({
    mutationFn: (id: number) => grantService.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "grants"] }); toast.success("已撤销授权") },
  })

  const rows = (list.data?.grants || []).filter((g) => {
    if (!q) return true
    const gname = granteeName(granteeCat, g.grantee_type, g.grantee_id)
    const sname = g.subject_type === "all" ? "全部资产" : subjectCat[g.subject_type]?.get(g.subject_id)?.name ?? ""
    return (gname + sname).toLowerCase().includes(q.toLowerCase())
  })

  return (
    <div className="space-y-3">
      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索授权对象或资产" className="pl-8" />
      </div>
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">授权给</th>
              <th className="px-3 py-2 text-left font-medium">可访问</th>
              <th className="px-3 py-2 text-left font-medium">权限</th>
              <th className="px-3 py-2 text-left font-medium">有效期</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.isLoading ? (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">加载中…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">还没有授权。点右上角「新建授权」开始。</td></tr>
            ) : (
              rows.map((g) => (
                <tr key={g.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-normal">{GRANTEE_KIND_LABEL[g.grantee_type]}</Badge>
                      <span className="font-medium">{granteeName(granteeCat, g.grantee_type, g.grantee_id)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {g.subject_type === "all" ? (
                      <Badge className="bg-amber-500/15 font-normal text-amber-700 dark:text-amber-300">全部资产</Badge>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-normal">{VIA_LABEL[g.subject_type]}</Badge>
                        <span>{subjectCat[g.subject_type]?.get(g.subject_id)?.name ?? `#${g.subject_id}`}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <ActionChips actions={g.actions.split(",").filter(Boolean)} />
                  </td>
                  <td className="px-3 py-2"><ValidityCell to={g.valid_to} /></td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost" size="icon" className="h-7 w-7"
                      onClick={async () => {
                        if (await confirmDialog({ title: "撤销这条授权？", destructive: true })) remove.mutate(g.id)
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---- 按人看 ----------------------------------------------------------------

function ByGranteeTab({
  granteeCats, granteeCat, nodes, assetGroups, tags, onChanged,
}: {
  granteeCats: GranteeCat[]
  granteeCat: Catalog
  nodes: Node[]
  assetGroups: AssetGroup[]
  tags: { id: number; name: string }[]
  onChanged: () => void
}) {
  const [sel, setSel] = React.useState<{ type: GranteeKind; id: number } | null>(null)
  const [q, setQ] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [detailNode, setDetailNode] = React.useState<Node | null>(null)
  const [detailOpen, setDetailOpen] = React.useState(false)

  const exp = useQuery({
    queryKey: ["access", "by-grantee", sel?.type, sel?.id],
    queryFn: () => grantService.byGrantee(sel!.type, sel!.id),
    enabled: !!sel,
  })

  // Reset selection whenever the grantee changes.
  React.useEffect(() => { setSelectedIds(new Set()); setQ("") }, [sel?.type, sel?.id])

  const nodeById = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const granteeName2 = React.useMemo(
    () => granteeNameFrom((t, id) => granteeCat[t]?.get(id)?.name),
    [granteeCat],
  )

  // Filter the reachable set by the search box (name / host / actions) before
  // hanging it on the group hierarchy, so search prunes the tree.
  const reach = React.useMemo(() => {
    const all = exp.data?.nodes ?? []
    const k = q.trim().toLowerCase()
    if (!k) return all
    return all.filter((na) => {
      const n = nodeById.get(na.node_id)
      const hay = `${n?.name ?? ""} ${n?.host ?? ""} ${n?.tags ?? ""} ${na.actions.join(" ")}`.toLowerCase()
      return hay.includes(k)
    })
  }, [exp.data, q, nodeById])

  const tree = React.useMemo(() => buildAccessTree(assetGroups, reach, nodeById), [assetGroups, reach, nodeById])
  const expandedSeed = React.useMemo(() => collectGroupRowIds(tree), [tree])

  // Selected node ids (numeric) → batch + detail.
  const selectedNodeIds = React.useMemo(() => {
    const out: number[] = []
    const walk = (rows: AccessTreeRow[]) => {
      for (const r of rows) {
        if (r.kind === "node") { if (selectedIds.has(r.id)) out.push(r.nodeId) }
        else walk(r.children)
      }
    }
    walk(tree)
    return [...new Set(out)]
  }, [tree, selectedIds])
  const selectedNodes = React.useMemo(
    () => selectedNodeIds.map((id) => nodeById.get(id)).filter(Boolean) as Node[],
    [selectedNodeIds, nodeById],
  )

  const openDetail = (n: Node) => { setDetailNode(n); setDetailOpen(true) }

  return (
    <div className="space-y-3">
      <EntityCombobox cats={granteeCats} value={sel} onChange={setSel} placeholder="选一个用户 / 角色 / 用户组 / 部门" />
      {!sel ? (
        <EmptyHint text="选一个对象，看他实际能访问哪些资产 —— 已穿透用户组、角色、部门，并按资产组层级组织成树。" />
      ) : exp.isLoading ? (
        <EmptyHint text="解析中…" />
      ) : (
        <div className="space-y-2">
          {exp.data?.all_actions?.length ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
              <span className="text-warning">拥有<strong>全部资产</strong>权限：</span>
              <ActionChips actions={exp.data.all_actions} />
              {exp.data.all_valid_to ? <ValidityCell to={exp.data.all_valid_to} /> : null}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="在可达资产中搜索…" className="pl-8" />
            </div>
            <span className="ml-auto text-xs text-muted-foreground">实际可访问 {exp.data?.nodes.length ?? 0} 台</span>
          </div>

          {selectedNodeIds.length > 0 && (
            <BatchActionBar count={selectedNodeIds.length} noun="资产" onClear={() => setSelectedIds(new Set())}>
              <NodeBatchActions
                nodeIds={selectedNodeIds}
                nodes={selectedNodes}
                groups={assetGroups}
                tags={tags as never}
                canMutate
                onChanged={onChanged}
              />
            </BatchActionBar>
          )}

          {tree.length === 0 && !exp.data?.all_actions?.length ? (
            <EmptyHint text="没有任何资产授权。" />
          ) : (
            <div className="rounded-lg border p-1">
              <TreeList<AccessTreeRow>
                key={`${sel.type}:${sel.id}:${q}`}
                nodes={tree}
                getId={(r) => r.id}
                getChildren={childrenOfRow}
                defaultExpandedIds={expandedSeed}
                selectable
                selectedIds={selectedIds}
                onSelectedChange={setSelectedIds}
                canSelect={(r) => r.kind === "node"}
                indent={16}
                renderRow={(r) => (
                  <AccessRow
                    row={r}
                    granteeName={(t, id) => granteeName2(t, id)}
                    onOpenDetail={openDetail}
                  />
                )}
              />
            </div>
          )}
        </div>
      )}

      <NodeDetailPanel
        node={detailNode}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        access={detailNode ? exp.data?.nodes.find((n) => n.node_id === detailNode.id) ?? null : null}
        granteeName={granteeName2}
        withSessions
      />
    </div>
  )
}

// One row of the 按人看 access tree — folder header (count) or a node leaf with
// action chips, source grantees and expiry.
function AccessRow({
  row, granteeName, onOpenDetail,
}: {
  row: AccessTreeRow
  granteeName: (type: GranteeKind, id: number) => string
  onOpenDetail: (n: Node) => void
}) {
  if (row.kind !== "node") {
    return (
      <div className="flex items-center gap-1.5 py-1 pr-1 text-sm">
        <span className="flex-1 truncate font-medium">{row.label}</span>
        <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{row.total}</span>
      </div>
    )
  }
  const n = row.node
  return (
    <button
      type="button"
      onClick={() => n && onOpenDetail(n)}
      className="flex w-full items-center gap-2 py-1 pr-1 text-left text-sm"
    >
      {n ? <AppIcon icon={nodeIcon(n)} className="h-3.5 w-3.5 shrink-0" /> : null}
      <span className="min-w-0 flex-1 truncate">{n?.name ?? `节点#${row.nodeId}`}</span>
      {n ? <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{n.host}:{n.port}</span> : null}
      {row.access ? <ActionChips actions={row.access.actions} className="hidden md:flex" /> : null}
      {row.access?.sources?.length ? (
        <span className="hidden shrink-0 text-[10px] text-muted-foreground lg:inline">
          来自：{row.access.sources.map((s) => granteeName(s.type, s.id)).join("、")}
        </span>
      ) : null}
      <ValidityCell to={row.access?.valid_to} className="shrink-0" />
    </button>
  )
}

// ---- 按资产看 --------------------------------------------------------------

function BySubjectTab({
  subjectCat, granteeCat, onChanged,
}: {
  subjectCat: Catalog
  granteeCat: Catalog
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const nodeCat = React.useMemo<GranteeCat[]>(
    () => [{ key: "node", label: "节点", items: Array.from(subjectCat.node?.values() ?? []) }],
    [subjectCat],
  )
  const [sel, setSel] = React.useState<{ type: string; id: number } | null>(null)
  const who = useQuery({
    queryKey: ["access", "by-subject", sel?.id],
    queryFn: () => grantService.bySubject(sel!.id),
    enabled: !!sel,
  })
  const remove = useMutation({
    mutationFn: (id: number) => grantService.remove(id),
    onSuccess: () => {
      toast.success("已撤销")
      qc.invalidateQueries({ queryKey: ["access", "by-subject"] })
      onChanged()
    },
  })

  return (
    <div className="space-y-3">
      <EntityCombobox
        cats={nodeCat}
        value={sel as { type: GranteeKind; id: number } | null}
        onChange={(v) => setSel(v)}
        placeholder="选一台节点资产"
      />
      {!sel ? (
        <EmptyHint text="选一台资产，看到底谁能进、经由什么授权。" />
      ) : who.isLoading ? (
        <EmptyHint text="查询中…" />
      ) : (who.data?.grantees.length ?? 0) === 0 ? (
        <EmptyHint text="目前没有人能访问这台资产。" />
      ) : (
        <div className="overflow-hidden rounded-lg border divide-y">
          {(who.data?.grantees || []).map((row) => (
            <div key={row.grant_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30">
              <Badge variant="outline" className="font-normal">{GRANTEE_KIND_LABEL[row.grantee_type]}</Badge>
              <span className="font-medium">{granteeName(granteeCat, row.grantee_type, row.grantee_id)}</span>
              <ActionChips actions={row.actions} />
              <Badge variant="secondary" className="font-normal">经由 {VIA_LABEL[row.via]}</Badge>
              <div className="ml-auto flex items-center gap-2">
                <ValidityCell to={row.valid_to} />
                <Button
                  variant="ghost" size="icon" className="h-7 w-7"
                  onClick={async () => {
                    if (await confirmDialog({ title: "撤销这条授权？", destructive: true })) remove.mutate(row.grant_id)
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed px-3 py-10 text-center text-sm text-muted-foreground">{text}</div>
}

// ---- 单选下拉（跨类目搜索） ------------------------------------------------

interface GranteeCat {
  key: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  items: Entity[]
}

function EntityCombobox({
  cats, value, onChange, placeholder,
}: {
  cats: GranteeCat[]
  value: { type: GranteeKind; id: number } | null
  onChange: (v: { type: GranteeKind; id: number } | null) => void
  placeholder: string
}) {
  const [open, setOpen] = React.useState(false)
  const current = value ? cats.find((c) => c.key === value.type)?.items.find((i) => i.id === value.id) : null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full max-w-md justify-between">
          {current ? current.name : <span className="text-muted-foreground">{placeholder}</span>}
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
                    onSelect={() => { onChange({ type: c.key as GranteeKind, id: i.id }); setOpen(false) }}
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

