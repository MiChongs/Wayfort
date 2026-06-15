"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FolderPlus,
  FolderTree,
  Loader2,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Tag as TagIcon,
  X,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { NodeTree, type AssetSelection, type GrantSubject } from "@/components/admin/nodes/node-tree"
import { NodeInspector } from "@/components/admin/assets/node-inspector"
import { GroupInspector } from "@/components/admin/assets/group-inspector"
import { GrantWizard } from "@/components/admin/grant-wizard"
import { BatchActionBar } from "@/components/common/batch-action-bar"
import { NodeBatchActions } from "@/components/asset-tree/node-batch-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { EmptyState } from "@/components/common/empty-state"
import { assetGroupService, domainService, nodeService, proxyService, tagService } from "@/lib/api/services"
import { TagPicker } from "@/components/tags/tag-picker"
import { AppIcon } from "@/components/icons/app-icon"
import { IconPicker } from "@/components/icons/icon-picker"
import { nodeIcon, protocolIconToken } from "@/lib/icons/protocol"
import { CredentialPicker } from "@/components/admin/credential-picker"
import type { AssetGroup, Domain, Node, NodeListParams, NodeProtocol, Proxy } from "@/lib/api/types"
import { RdpOptionsForm } from "@/components/admin/nodes/rdp-options-form"
import { OssOptionsForm } from "@/components/admin/nodes/oss-options-form"
import { cn } from "@/lib/utils"

const NODES_KEY = ["admin", "nodes"] as const

const SORT_OPTIONS: { value: string; label: string; sort: NodeListParams["sort"]; order: NodeListParams["order"] }[] = [
  { value: "name-asc", label: "名称 A→Z", sort: "name", order: "asc" },
  { value: "name-desc", label: "名称 Z→A", sort: "name", order: "desc" },
  { value: "protocol-asc", label: "协议", sort: "protocol", order: "asc" },
  { value: "created-desc", label: "最新创建", sort: "created_at", order: "desc" },
  { value: "created-asc", label: "最早创建", sort: "created_at", order: "asc" },
]


// ============================================================================
// Unified asset console — one master-detail surface to build the multi-level
// asset tree (groups + nodes), place/move nodes, and assign assets to users.
// Left: the tree (group / tag views, drag to organize, multi-select → batch).
// Right: an inspector for the selected node or group (edit · members · grant).
// ============================================================================

export default function AdminNodesPage() {
  const qc = useQueryClient()
  const [search, setSearch] = React.useState("")
  const [q, setQ] = React.useState("")
  const [protocol, setProtocol] = React.useState<string>("all")
  const [status, setStatus] = React.useState<string>("all")
  const [treeBy, setTreeBy] = React.useState<"group" | "tag">("group")
  const [selected, setSelected] = React.useState<Set<number>>(new Set()) // multi-select → batch
  const [selection, setSelection] = React.useState<AssetSelection | null>(null) // single → inspector
  const [editing, setEditing] = React.useState<Node | null>(null)
  const [groupParent, setGroupParent] = React.useState<number | null | undefined>(undefined) // create-group dialog
  const [grantSubject, setGrantSubject] = React.useState<GrantSubject | null>(null) // 右键「分配给用户」→ 受控授权 Sheet

  React.useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  const params: NodeListParams = {
    q: q || undefined,
    protocol: protocol === "all" ? undefined : protocol,
    enabled: status === "all" ? undefined : (status as "true" | "false"),
    sort: "name",
    order: "asc",
  }
  const nodes = useQuery({ queryKey: [...NODES_KEY, params], queryFn: () => nodeService.search(params) })
  const proxies = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })
  const assetGroups = useQuery({ queryKey: ["admin", "asset-groups"], queryFn: assetGroupService.list })
  const tags = useQuery({ queryKey: ["admin", "tags"], queryFn: tagService.list })

  const rows = React.useMemo(() => nodes.data?.nodes ?? [], [nodes.data])
  const groups = React.useMemo(() => assetGroups.data?.asset_groups ?? [], [assetGroups.data])
  const invalidate = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: NODES_KEY })
    qc.invalidateQueries({ queryKey: ["admin", "asset-groups"] })
  }, [qc])
  const selectedNodes = React.useMemo(() => rows.filter((n) => selected.has(n.id)), [rows, selected])

  // Unique member count over each group's whole subtree (a node can sit in
  // several sub-groups; de-dupe) — feeds the group inspector header.
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
      const c = cache.get(g.id)
      if (c) return c
      const set = new Set<number>(g.node_ids ?? [])
      for (const ch of childrenOf.get(g.id) ?? []) for (const id of compute(ch)) set.add(id)
      cache.set(g.id, set)
      return set
    }
    const out = new Map<number, number>()
    for (const g of groups) out.set(g.id, compute(g).size)
    return out
  }, [groups])

  const removeMut = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(ids.map((id) => nodeService.remove(id)))
    },
    onSuccess: () => {
      toast.success("已删除")
      setSelected(new Set())
      invalidate()
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })
  const createGroup = useMutation({
    mutationFn: (body: { name: string; parent_id: number | null }) =>
      assetGroupService.create(body as Partial<AssetGroup>),
    onSuccess: () => {
      setGroupParent(undefined)
      invalidate()
      toast.success("已创建资产组")
    },
    onError: (e: Error) => toast.error("创建失败", { description: e.message }),
  })

  const selectedNode = selection?.kind === "node" ? rows.find((n) => n.id === selection.id) ?? null : null
  const selectedGroup = selection?.kind === "group" ? groups.find((g) => g.id === selection.id) ?? null : null
  const selectedIds = Array.from(selected)
  const noAssets =
    !nodes.isLoading && rows.length === 0 && groups.length === 0 && !q && protocol === "all" && status === "all"

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Server className="h-5 w-5" />
            </span>
            资产
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            建多级资产组、把节点放进树、把资产分配给用户 —— 都在这一个控制台里完成。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setGroupParent(null)}>
            <FolderPlus className="h-4 w-4" /> 新建资产组
          </Button>
          <NodeFormSheet
            mode="create"
            proxies={proxies.data?.proxies ?? []}
            onSaved={invalidate}
            trigger={
              <Button>
                <Plus className="h-4 w-4" /> 新增节点
              </Button>
            }
          />
        </div>
      </div>

      {noAssets ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={Server}
            title="还没有任何资产"
            description="先新建资产组搭好层级，再把节点放进去；随后即可把资产分配给用户、在工作台连接。"
            action={
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setGroupParent(null)}>
                  <FolderPlus className="h-4 w-4" /> 新建资产组
                </Button>
                <NodeFormSheet
                  mode="create"
                  proxies={proxies.data?.proxies ?? []}
                  onSaved={invalidate}
                  trigger={
                    <Button>
                      <Plus className="h-4 w-4" /> 新增节点
                    </Button>
                  }
                />
              </div>
            }
          />
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索名称 / 主机 / 标签…"
                className="pl-9"
              />
            </div>
            <Select value={protocol} onValueChange={setProtocol}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="协议" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部协议</SelectItem>
                {PROTOCOL_GROUPS.map((g) => (
                  <SelectGroup key={g.label}>
                    <SelectLabel>{g.label}</SelectLabel>
                    {g.items.map((it) => (
                      <SelectItem key={it.value} value={it.value}>
                        {it.value}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="true">已启用</SelectItem>
                <SelectItem value="false">已停用</SelectItem>
              </SelectContent>
            </Select>
            <div className="ml-auto inline-flex rounded-lg border bg-card p-0.5">
              {(
                [
                  { v: "group" as const, icon: FolderTree, label: "按资产组" },
                  { v: "tag" as const, icon: TagIcon, label: "按标签" },
                ]
              ).map(({ v, icon: Icon, label }) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setTreeBy(v)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors",
                    treeBy === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
          </div>

          {/* Master-detail */}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
            {/* Left: tree */}
            <div className="flex min-h-0 flex-col rounded-xl border border-border bg-card">
              {selectedIds.length > 0 && (
                <div className="shrink-0 border-b p-2">
                  <BatchActionBar count={selectedIds.length} noun="节点" onClear={() => setSelected(new Set())}>
                    <NodeBatchActions
                      nodeIds={selectedIds}
                      nodes={selectedNodes}
                      groups={groups}
                      tags={tags.data?.tags ?? []}
                      canMutate
                      onChanged={() => {
                        setSelected(new Set())
                        invalidate()
                      }}
                      onDelete={() => {
                        if (confirm(`确认删除所选 ${selectedIds.length} 个节点？`)) removeMut.mutate(selectedIds)
                      }}
                    />
                  </BatchActionBar>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {nodes.isLoading ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div>
                ) : (
                  <NodeTree
                    nodes={rows}
                    groups={groups}
                    treeBy={treeBy}
                    selectedNodeIds={selected}
                    onSelectedNodeIds={setSelected}
                    selected={selection}
                    onSelect={setSelection}
                    onNewSubgroup={(parentId) => setGroupParent(parentId)}
                    onEditNode={setEditing}
                    onGrant={setGrantSubject}
                    onChanged={invalidate}
                  />
                )}
              </div>
            </div>

            {/* Right: inspector */}
            <div className="min-h-0 overflow-hidden rounded-xl border border-border bg-card">
              {selectedNode ? (
                <NodeInspector
                  key={selectedNode.id}
                  node={selectedNode}
                  onEdit={setEditing}
                  onDeleted={() => {
                    setSelection(null)
                    invalidate()
                  }}
                  onChanged={invalidate}
                />
              ) : selectedGroup ? (
                <GroupInspector
                  key={selectedGroup.id}
                  group={selectedGroup}
                  nodes={rows}
                  directCount={selectedGroup.node_ids?.length ?? 0}
                  subtreeCount={subtreeCount.get(selectedGroup.id) ?? 0}
                  onNewSubgroup={(parentId) => setGroupParent(parentId)}
                  onDeleted={() => {
                    setSelection(null)
                    invalidate()
                  }}
                  onChanged={invalidate}
                />
              ) : (
                <div className="grid h-full place-items-center p-6">
                  <EmptyState
                    icon={FolderTree}
                    title="选择资产组或节点"
                    description="在左侧点选资产组管理成员与授权，或点选节点查看详情、编辑、分配给用户。"
                  />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Edit node */}
      {editing && (
        <NodeFormSheet
          mode="edit"
          node={editing}
          proxies={proxies.data?.proxies ?? []}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          onSaved={() => {
            invalidate()
            setEditing(null)
          }}
        />
      )}

      {/* Create group */}
      <CreateGroupDialog
        open={groupParent !== undefined}
        parentName={typeof groupParent === "number" ? groups.find((g) => g.id === groupParent)?.name : undefined}
        pending={createGroup.isPending}
        onClose={() => setGroupParent(undefined)}
        onCreate={(name) => createGroup.mutate({ name, parent_id: groupParent ?? null })}
      />

      {/* Assign (右键「分配给用户」) — controlled grant Sheet */}
      <GrantWizard
        open={!!grantSubject}
        onOpenChange={(o) => !o && setGrantSubject(null)}
        fixedSubject={grantSubject ?? undefined}
        onDone={() => {
          invalidate()
          setGrantSubject(null)
        }}
      />
    </div>
  )
}

function CreateGroupDialog({
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
  onCreate: (name: string) => void
}) {
  const [name, setName] = React.useState("")
  React.useEffect(() => {
    if (open) setName("")
  }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{parentName ? `在「${parentName}」下新建子组` : "新建顶级资产组"}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="资产组名称"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) onCreate(name.trim())
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button disabled={!name.trim() || pending} onClick={() => onCreate(name.trim())}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----------------------------------------------------------------------------
// NodeFormSheet — create + edit. Keeps the smart host paste, protocol-aware
// port defaults, chip proxy-chain editor, tag chips, and per-protocol options,
// and adds approval gates + a live connectivity test in edit mode.
// ----------------------------------------------------------------------------

const PROTOCOL_GROUPS: { label: string; items: { value: NodeProtocol; hint?: string }[] }[] = [
  { label: "字符", items: [{ value: "ssh" }, { value: "telnet" }] },
  { label: "图形", items: [{ value: "rdp" }, { value: "vnc" }] },
  {
    label: "数据库",
    items: [{ value: "mysql" }, { value: "postgres" }, { value: "redis" }, { value: "mongo" }],
  },
  {
    label: "国产数据库",
    items: [
      { value: "dameng", hint: "达梦 DM8 · Oracle 风格" },
      { value: "kingbase", hint: "人大金仓 · PG 兼容" },
      { value: "vastbase", hint: "海量 Vastbase · PG 兼容" },
      { value: "highgo", hint: "瀚高 HighgoDB · PG 兼容" },
      { value: "opengauss", hint: "华为 openGauss · PG 兼容" },
      { value: "gaussdb", hint: "华为 GaussDB · PG 兼容" },
      { value: "gbase8s", hint: "南大通用 GBase 8s · PG 兼容" },
      { value: "tidb", hint: "PingCAP TiDB · MySQL 兼容" },
      { value: "oceanbase", hint: "蚂蚁 OceanBase · MySQL 兼容" },
      { value: "starrocks", hint: "StarRocks · MySQL 兼容 (OLAP)" },
      { value: "doris", hint: "Apache Doris · MySQL 兼容 (OLAP)" },
      { value: "gbase8a", hint: "南大通用 GBase 8a · MySQL 兼容" },
    ],
  },
  { label: "对象存储", items: [{ value: "oss", hint: "阿里云 OSS / 腾讯 COS / S3 兼容" }] },
  { label: "通用", items: [{ value: "tcp", hint: "任意 TCP 端口转发" }] },
]

type NodeDraft = Partial<Node> & { credential_id?: number }

function NodeFormSheet({
  mode,
  node,
  proxies,
  trigger,
  open: controlledOpen,
  onOpenChange,
  onSaved,
}: {
  mode: "create" | "edit"
  node?: Node
  proxies: Proxy[]
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (v: boolean) => void
  onSaved: () => void
}) {
  const isControlled = controlledOpen !== undefined
  const [internalOpen, setInternalOpen] = React.useState(false)
  const open = isControlled ? controlledOpen! : internalOpen
  const setOpen = (v: boolean) => (isControlled ? onOpenChange?.(v) : setInternalOpen(v))

  const [draft, setDraft] = React.useState<NodeDraft>(() => seedDraft(node))
  // Managed colour tags, kept separate from the node body and committed via a
  // dedicated replace call after the node saves.
  const [tagIds, setTagIds] = React.useState<number[]>(() => (node?.tag_list || []).map((t) => t.id))
  const lastAutoPortRef = React.useRef<number | undefined>(node ? node.port : 22)

  React.useEffect(() => {
    if (open) {
      setDraft(seedDraft(node))
      setTagIds((node?.tag_list || []).map((t) => t.id))
      lastAutoPortRef.current = node ? node.port : 22
    }
  }, [open, node])

  const save = useMutation({
    mutationFn: async () => {
      const saved =
        mode === "edit" && node
          ? await nodeService.update(node.id, draft)
          : await nodeService.create(draft as Node)
      const nodeId = (saved as Node)?.id ?? node?.id
      if (nodeId) {
        // Non-fatal: the node itself is already saved; tag wiring is best-effort.
        try {
          await tagService.replaceNodeTags(nodeId, tagIds)
        } catch {
          /* keep the node save; surface nothing — tags can be fixed in the editor */
        }
      }
      return saved
    },
    onSuccess: () => {
      setOpen(false)
      onSaved()
      toast.success(mode === "edit" ? "已保存节点" : "已创建节点")
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  const onHostPaste = (raw: string) => {
    let value = raw.trim()
    let user = ""
    if (value.includes("@")) {
      const [u, rest] = value.split("@", 2)
      user = u
      value = rest
    }
    let port: number | undefined
    if (value.includes(":")) {
      const [h, p] = value.split(":", 2)
      const num = Number(p)
      if (Number.isFinite(num) && num > 0) {
        port = num
        value = h
      }
    }
    setDraft((d) => ({
      ...d,
      host: value,
      username: d.username || user,
      port: port ?? d.port,
      name: d.name || value,
    }))
    if (port !== undefined) lastAutoPortRef.current = port
  }

  const onProtocolChange = (next: NodeProtocol) => {
    const defaultPortNext = defaultPort(next)
    setDraft((d) => {
      const keep = d.port !== lastAutoPortRef.current
      lastAutoPortRef.current = defaultPortNext
      return { ...d, protocol: next, port: keep ? d.port : defaultPortNext }
    })
  }

  // Domains decide HOW the gateway reaches the asset (direct / proxy / agent).
  const domainsQ = useQuery({
    queryKey: ["admin", "domains", "all"],
    queryFn: () => domainService.list(),
    enabled: open,
  })
  const domains: Domain[] = domainsQ.data?.domains ?? []
  const selectedDomain = draft.domain_id != null ? domains.find((dm) => dm.id === draft.domain_id) : undefined

  const chainIDs = parseChain(draft.proxy_chain)
  const setChain = (next: number[]) => setDraft((d) => ({ ...d, proxy_chain: next.join(",") }))

  const canSubmit = Boolean(draft.name && draft.host && draft.credential_id) && !save.isPending

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
      <SheetContent side="right" className="flex !w-full flex-col gap-0 p-0 sm:!max-w-2xl">
        <SheetHeader className="shrink-0 border-b px-6 py-4">
          <SheetTitle>{mode === "edit" ? "编辑节点" : "新增节点"}</SheetTitle>
          <SheetDescription>
            填好主机与凭据即可保存。代理链、标签、协议参数全部可选；保存后随时编辑。
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <section className="space-y-4">
            <FieldGrid>
              <Field label="名称" required>
                <Input
                  value={draft.name || ""}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="留空将自动用主机名"
                />
              </Field>
              <Field label="协议" required>
                <Select value={draft.protocol} onValueChange={(v) => onProtocolChange(v as NodeProtocol)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROTOCOL_GROUPS.map((g) => (
                      <SelectGroup key={g.label}>
                        <SelectLabel>{g.label}</SelectLabel>
                        {g.items.map((it) => (
                          <SelectItem key={it.value} value={it.value}>
                            <span className="font-mono">{it.value}</span>
                            {it.hint && <span className="ml-2 text-xs text-muted-foreground">{it.hint}</span>}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGrid>

            <FieldGrid cols={[2, 1]}>
              <Field label="主机" required hint="支持粘贴 user@host:port，会自动拆开">
                <Input
                  value={draft.host || ""}
                  onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text")
                    if (text && (text.includes(":") || text.includes("@"))) {
                      e.preventDefault()
                      onHostPaste(text)
                    }
                  }}
                  placeholder="10.0.0.1 / db.internal"
                />
              </Field>
              <Field label="端口">
                <Input
                  type="number"
                  value={draft.port ?? ""}
                  onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
                  placeholder={String(defaultPort(draft.protocol as NodeProtocol))}
                />
              </Field>
            </FieldGrid>

            <FieldGrid>
              <Field label="登录用户名" hint="远端节点上的账号，不是堡垒机本身的">
                <Input
                  value={draft.username || ""}
                  onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  placeholder="root / Administrator / 留空走凭据"
                />
              </Field>
              <Field label="凭据" required>
                <CredentialPicker
                  value={draft.credential_id ?? null}
                  onChange={(id) => setDraft({ ...draft, credential_id: id ?? undefined })}
                  aria-invalid={!draft.credential_id}
                />
              </Field>
            </FieldGrid>
          </section>

          <Separator />

          {/* Network domain — the source of truth for HOW the gateway reaches
              this asset. Agent domains tunnel in via a reverse-connect agent. */}
          <section className="space-y-2">
            <Field
              label="网域"
              hint="决定如何到达该资产：Agent 域经内网反连 Agent 接入；留空 = 默认直连域。"
            >
              <Select
                value={draft.domain_id != null ? String(draft.domain_id) : "0"}
                onValueChange={(v) => setDraft((d) => ({ ...d, domain_id: Number(v) }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="默认（直连域）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">默认（直连域）</SelectItem>
                  {domains
                    .filter((dm) => !dm.is_default)
                    .map((dm) => (
                      <SelectItem key={dm.id} value={String(dm.id)}>
                        {dm.name}
                        {dm.kind === "agent" ? "（Agent 反连）" : dm.kind === "proxy" ? "（代理）" : "（直连）"}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            {selectedDomain?.kind === "agent" && draft.proxy_chain ? (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                注意：下方「代理链」非空会作为遗留覆盖优先生效，使资产绕过所选 Agent 域。要走 Agent 请先清空代理链。
              </p>
            ) : null}
          </section>

          <CollapsibleSection
            title="代理链"
            summary={
              chainIDs.length === 0
                ? "直连"
                : chainIDs.map((id) => proxies.find((p) => p.id === id)?.name ?? `#${id}`).join(" → ")
            }
          >
            <ProxyChainEditor proxies={proxies} value={chainIDs} onChange={setChain} />
          </CollapsibleSection>

          <CollapsibleSection title="标签与元数据" summary={[draft.region, tagIds.length ? `${tagIds.length} 个标签` : ""].filter(Boolean).join(" · ") || "未设置"}>
            <FieldGrid>
              <Field label="图标">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent">
                    <AppIcon icon={nodeIcon(draft)} size={18} />
                  </span>
                  <IconPicker
                    value={draft.icon || ""}
                    onChange={(t) => setDraft({ ...draft, icon: t })}
                    placeholder="跟随协议"
                    triggerClassName="flex-1"
                  />
                </div>
                {!draft.icon && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    留空则按协议自动选择（{protocolIconToken(draft.protocol).replace(/^.*:/, "")}）
                  </p>
                )}
              </Field>
              <Field label="区域">
                <Input
                  value={draft.region || ""}
                  onChange={(e) => setDraft({ ...draft, region: e.target.value })}
                  placeholder="cn-hangzhou / dc1"
                />
              </Field>
            </FieldGrid>
            <Field label="标签" className="mt-3">
              <TagPicker value={tagIds} onChange={setTagIds} />
            </Field>
            <Field label="描述" className="mt-3">
              <Textarea
                rows={2}
                value={draft.description || ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="一句话说明这台机器是做什么的，会出现在节点详情里"
              />
            </Field>
          </CollapsibleSection>

          <CollapsibleSection
            title="访问控制"
            summary={
              draft.requires_approval_for_connect || draft.requires_approval_for_file_xfer ? "已开启审批" : "无需审批"
            }
          >
            <div className="space-y-2.5">
              <ApprovalToggle
                label="连接前需审批"
                hint="用户发起连接时，需一条有效的资产访问审批授权。"
                checked={!!draft.requires_approval_for_connect}
                onChange={(v) => setDraft({ ...draft, requires_approval_for_connect: v })}
              />
              <ApprovalToggle
                label="文件传输需审批"
                hint="SFTP 上传 / 下载前需审批。适合存放敏感数据的主机。"
                checked={!!draft.requires_approval_for_file_xfer}
                onChange={(v) => setDraft({ ...draft, requires_approval_for_file_xfer: v })}
              />
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title={draft.protocol === "oss" ? "对象存储配置" : "协议参数"}
            summary={
              draft.protocol === "oss"
                ? "服务商 / Endpoint / Region / 默认 Bucket"
                : draft.protocol === "rdp"
                  ? "RDP 安全协议、显示、性能等"
                  : draft.proto_options
                    ? "已设置 JSON"
                    : "默认"
            }
            defaultOpen={draft.protocol === "rdp" || draft.protocol === "oss"}
          >
            {draft.protocol === "oss" ? (
              <OssOptionsForm
                value={draft.proto_options || ""}
                credentialId={draft.credential_id}
                proxyChain={draft.proxy_chain}
                onChange={({ proto_options, host, region, port }) =>
                  setDraft((d) => ({ ...d, proto_options, host, region, port }))
                }
              />
            ) : draft.protocol === "rdp" ? (
              <RdpOptionsForm value={draft.proto_options} onChange={(v) => setDraft({ ...draft, proto_options: v })} />
            ) : (
              <Field label="JSON 覆盖" hint="留空走协议默认值；只有需要覆盖时填写">
                <Textarea
                  rows={4}
                  className="font-mono text-xs"
                  value={draft.proto_options || ""}
                  onChange={(e) => setDraft({ ...draft, proto_options: e.target.value })}
                  placeholder={protoOptionsExample(draft.protocol as NodeProtocol)}
                />
              </Field>
            )}
          </CollapsibleSection>

          {mode === "edit" && node && <NodeTestPanel node={node} />}
        </div>

        <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t bg-secondary/40 px-6 py-4">
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSubmit}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === "edit" ? "保存修改" : "保存"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function ApprovalToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3">
      <div className="space-y-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> {label}
        </span>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

function NodeTestPanel({ node }: { node: Node }) {
  const test = useMutation({ mutationFn: () => nodeService.test(node.id) })
  const r = test.data
  return (
    <div className="space-y-2 rounded-lg border border-dashed bg-secondary/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Activity className="h-4 w-4 text-muted-foreground" /> 连通性测试
        </span>
        <Button type="button" variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
          测试
        </Button>
      </div>
      {r && (
        <p className={cn("text-xs", r.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
          {r.ok
            ? `连接成功 · ${r.mode?.toUpperCase()} · ${r.latency_ms}ms · ${r.target}`
            : `连接失败：${r.error}`}
        </p>
      )}
    </div>
  )
}

// ----- helpers --------------------------------------------------------------

function seedDraft(node?: Node): NodeDraft {
  if (node) return { ...node, credential_id: node.credential_id }
  return { protocol: "ssh", port: 22, name: "", host: "", username: "" }
}

function defaultPort(p: NodeProtocol): number {
  const ports: Partial<Record<NodeProtocol, number>> = {
    ssh: 22, telnet: 23, rdp: 3389, vnc: 5900,
    mysql: 3306, postgres: 5432, redis: 6379, mongo: 27017, tcp: 0,
    dameng: 5236,
    kingbase: 54321, vastbase: 5432, highgo: 5866,
    opengauss: 5432, gaussdb: 5432, gbase8s: 9088,
    tidb: 4000, oceanbase: 2881, starrocks: 9030, doris: 9030, gbase8a: 5258,
    oss: 443,
  }
  return ports[p] ?? 0
}

function protoOptionsExample(p: NodeProtocol): string {
  switch (p) {
    case "vnc":
      return '{ "color_depth": 24 }'
    case "mysql":
    case "postgres":
      return '{ "database": "main" }'
    case "mongo":
      return '{ "auth_db": "admin" }'
    case "tcp":
      return ""
    default:
      return "{}"
  }
}

function parseChain(s?: string): number[] {
  if (!s) return []
  return s
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

function Field({
  label,
  required,
  hint,
  className,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="eyebrow">
        {label}
        {required && <span className="ml-1 normal-case text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

function FieldGrid({ children, cols }: { children: React.ReactNode; cols?: [number, number] }) {
  if (cols) {
    return (
      <div className="grid gap-3" style={{ gridTemplateColumns: cols.map((c) => `${c}fr`).join(" ") }}>
        {children}
      </div>
    )
  }
  return <div className="grid grid-cols-2 gap-3">{children}</div>
}

function CollapsibleSection({
  title,
  summary,
  defaultOpen,
  children,
}: {
  title: string
  summary?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(!!defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group -mx-2 flex w-full select-none items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/40">
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open ? "rotate-0" : "-rotate-90")}
          />
          <span className="text-sm font-medium">{title}</span>
          {!open && summary && <span className="truncate text-xs text-muted-foreground">— {summary}</span>}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function ProxyChainEditor({
  proxies,
  value,
  onChange,
}: {
  proxies: Proxy[]
  value: number[]
  onChange: (next: number[]) => void
}) {
  const selectedSet = new Set(value)
  const available = proxies.filter((p) => !selectedSet.has(p.id))

  const move = (idx: number, delta: number) => {
    const next = [...value]
    const target = idx + delta
    if (target < 0 || target >= next.length) return
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">未选择代理 = 直连。点击下方代理可加入链路；最外层在最左。</p>
      ) : (
        <ol className="space-y-1.5">
          {value.map((id, i) => {
            const p = proxies.find((x) => x.id === id)
            return (
              <li key={id} className="flex items-center gap-2 rounded-md border bg-secondary/40 px-2 py-1.5 text-sm">
                <span className="w-5 text-center font-mono text-xs text-muted-foreground">{i + 1}</span>
                <Badge variant="soft" className="font-mono text-[10px]">
                  {p?.kind ?? "?"}
                </Badge>
                <span className="flex-1 truncate">
                  {p?.name ?? `代理 #${id} (已删除)`}
                  {p && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {p.host}:{p.port}
                    </span>
                  )}
                </span>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={i === value.length - 1}
                  onClick={() => move(i, +1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => onChange(value.filter((x) => x !== id))}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            )
          })}
        </ol>
      )}

      {available.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] text-muted-foreground">可用代理</div>
          <div className="flex flex-wrap gap-1.5">
            {available.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onChange([...value, p.id])}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="font-mono text-[10px] text-muted-foreground">{p.kind}</span>
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

