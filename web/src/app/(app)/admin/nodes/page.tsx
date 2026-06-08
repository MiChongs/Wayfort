"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FolderTree,
  Loader2,
  Pencil,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Table2,
  Trash2,
  Wifi,
  X,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { GrantWizard } from "@/components/admin/grant-wizard"
import { NodeTree } from "@/components/admin/nodes/node-tree"
import { BatchActionBar } from "@/components/common/batch-action-bar"
import { NodeBatchActions } from "@/components/asset-tree/node-batch-actions"
import { NodeDetailPanel } from "@/components/asset-tree/node-detail"
import { useNodeStatus } from "@/lib/hooks/use-node-status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { EmptyState } from "@/components/common/empty-state"
import { ConfirmDeleteDialog } from "@/components/admin/confirm-delete"
import { assetGroupService, nodeService, proxyService, tagService } from "@/lib/api/services"
import { TagPicker } from "@/components/tags/tag-picker"
import { AppIcon } from "@/components/icons/app-icon"
import { IconPicker } from "@/components/icons/icon-picker"
import { nodeIcon, protocolIconToken } from "@/lib/icons/protocol"
import { CredentialPicker } from "@/components/admin/credential-picker"
import type { Node, NodeListParams, NodeProtocol, Proxy } from "@/lib/api/types"
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

export default function AdminNodesPage() {
  const qc = useQueryClient()
  const [search, setSearch] = React.useState("")
  const [q, setQ] = React.useState("")
  const [protocol, setProtocol] = React.useState<string>("all")
  const [status, setStatus] = React.useState<string>("all")
  const [sortValue, setSortValue] = React.useState("name-asc")
  const [selected, setSelected] = React.useState<Set<number>>(new Set())
  const [editing, setEditing] = React.useState<Node | null>(null)
  const [deleting, setDeleting] = React.useState<Node | null>(null)
  // table ↔ tree view, persisted (SSR-safe: start on table, sync after mount).
  const [viewMode, setViewMode] = React.useState<"table" | "tree">("table")
  const [treeBy, setTreeBy] = React.useState<"group" | "tag">("group")
  const [detailNode, setDetailNode] = React.useState<Node | null>(null)
  const [detailOpen, setDetailOpen] = React.useState(false)
  const nodeStatus = useNodeStatus()
  React.useEffect(() => {
    const v = window.localStorage.getItem("admin:nodes:view")
    if (v === "tree" || v === "table") setViewMode(v)
  }, [])
  const changeView = (v: "table" | "tree") => {
    setViewMode(v)
    window.localStorage.setItem("admin:nodes:view", v)
  }
  const openDetail = (n: Node) => { setDetailNode(n); setDetailOpen(true); nodeStatus.request([n.id]) }

  // Debounce the free-text query so we don't refetch on every keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  const sortOpt = SORT_OPTIONS.find((s) => s.value === sortValue) ?? SORT_OPTIONS[0]
  const params: NodeListParams = {
    q: q || undefined,
    protocol: protocol === "all" ? undefined : protocol,
    enabled: status === "all" ? undefined : (status as "true" | "false"),
    sort: sortOpt.sort,
    order: sortOpt.order,
  }

  const nodes = useQuery({ queryKey: [...NODES_KEY, params], queryFn: () => nodeService.search(params) })
  const proxies = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })
  const assetGroups = useQuery({ queryKey: ["admin", "asset-groups"], queryFn: assetGroupService.list })
  const tags = useQuery({ queryKey: ["admin", "tags"], queryFn: tagService.list })

  const rows = nodes.data?.nodes ?? []
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: NODES_KEY })
    qc.invalidateQueries({ queryKey: ["admin", "asset-groups"] })
  }
  const selectedNodes = React.useMemo(() => rows.filter((n) => selected.has(n.id)), [rows, selected])

  const setDisabledMut = useMutation({
    mutationFn: async ({ ids, disabled }: { ids: number[]; disabled: boolean }) => {
      await Promise.all(ids.map((id) => nodeService.update(id, { disabled })))
    },
    onSuccess: (_d, v) => {
      toast.success(v.disabled ? "已停用所选节点" : "已启用所选节点")
      setSelected(new Set())
      invalidate()
    },
    onError: (e: Error) => toast.error("操作失败", { description: e.message }),
  })

  const removeMut = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(ids.map((id) => nodeService.remove(id)))
    },
    onSuccess: () => {
      toast.success("已删除")
      setSelected(new Set())
      setDeleting(null)
      invalidate()
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  const allChecked = rows.length > 0 && rows.every((n) => selected.has(n.id))
  const toggleAll = () => {
    setSelected(allChecked ? new Set() : new Set(rows.map((n) => n.id)))
  }
  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedIds = Array.from(selected)
  const noNodes = !nodes.isLoading && rows.length === 0 && !q && protocol === "all" && status === "all"

  return (
    <div className="space-y-5 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Server className="h-5 w-5" />
            </span>
            资产节点
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            统一纳管 SSH / RDP / 数据库等多协议主机。绑定凭据与代理链后，用户即可经授权连接。
          </p>
        </div>
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

      {noNodes ? (
        <div className="rounded-xl border bg-card">
          <EmptyState
            icon={Server}
            title="还没有任何节点"
            description="添加第一台主机后，即可在工作台连接、授权给用户、查看会话与系统指标。"
            action={
              <NodeFormSheet
                mode="create"
                proxies={proxies.data?.proxies ?? []}
                onSaved={invalidate}
                trigger={
                  <Button>
                    <Plus className="h-4 w-4" /> 新增第一台节点
                  </Button>
                }
              />
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
            <Select value={sortValue} onValueChange={setSortValue}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {viewMode === "tree" && (
              <Select value={treeBy} onValueChange={(v) => setTreeBy(v as "group" | "tag")}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="group">按资产组</SelectItem>
                  <SelectItem value="tag">按标签</SelectItem>
                </SelectContent>
              </Select>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1 text-xs"
                onClick={() => nodeStatus.request(rows.map((n) => n.id))}
                title="探测可见节点连通性"
              >
                <Wifi className="h-3.5 w-3.5" /> 探测
              </Button>
              {/* table ↔ tree switch */}
              <div className="inline-flex rounded-lg border bg-card p-0.5">
                <button
                  type="button"
                  onClick={() => changeView("table")}
                  className={cn(
                    "inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors",
                    viewMode === "table" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Table2 className="h-3.5 w-3.5" /> 表格
                </button>
                <button
                  type="button"
                  onClick={() => changeView("tree")}
                  className={cn(
                    "inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors",
                    viewMode === "tree" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <FolderTree className="h-3.5 w-3.5" /> 树形
                </button>
              </div>
              <span className="text-xs text-muted-foreground">{rows.length} 个节点</span>
            </div>
          </div>

          {/* Bulk bar — shared with the asset tree (authorize / group / tag /
              enable / export), plus a node-delete that opens the confirm. */}
          {selectedIds.length > 0 && (
            <BatchActionBar count={selectedIds.length} noun="节点" onClear={() => setSelected(new Set())}>
              <NodeBatchActions
                nodeIds={selectedIds}
                nodes={selectedNodes}
                groups={assetGroups.data?.asset_groups ?? []}
                tags={tags.data?.tags ?? []}
                canMutate
                onChanged={() => { setSelected(new Set()); invalidate() }}
                onDelete={() => {
                  if (confirm(`确认删除所选 ${selectedIds.length} 个节点？`)) removeMut.mutate(selectedIds)
                }}
              />
            </BatchActionBar>
          )}

          {/* Tree view */}
          {viewMode === "tree" ? (
            nodes.isLoading ? (
              <div className="rounded-xl border bg-card py-10 text-center text-muted-foreground">加载中…</div>
            ) : rows.length === 0 ? (
              <div className="rounded-xl border bg-card py-10 text-center text-muted-foreground">没有匹配的节点</div>
            ) : (
              <NodeTree
                nodes={rows}
                groups={assetGroups.data?.asset_groups ?? []}
                treeBy={treeBy}
                selectedNodeIds={selected}
                onSelectedNodeIds={setSelected}
                status={nodeStatus}
                onEdit={setEditing}
                onDelete={setDeleting}
                onOpenDetail={openDetail}
                onGranted={invalidate}
                onChanged={invalidate}
              />
            )
          ) : (
          /* Table */
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b bg-secondary/40 text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-2.5">
                    <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="全选" />
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">名称</th>
                  <th className="px-3 py-2.5 text-left font-medium">协议</th>
                  <th className="px-3 py-2.5 text-left font-medium">地址</th>
                  <th className="px-3 py-2.5 text-left font-medium">凭据</th>
                  <th className="px-3 py-2.5 text-left font-medium">代理链</th>
                  <th className="px-3 py-2.5 text-left font-medium">状态</th>
                  <th className="px-3 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {nodes.isLoading && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-muted-foreground">
                      加载中…
                    </td>
                  </tr>
                )}
                {!nodes.isLoading && rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-muted-foreground">
                      没有匹配的节点
                    </td>
                  </tr>
                )}
                {rows.map((n) => {
                  const checked = selected.has(n.id)
                  return (
                    <tr
                      key={n.id}
                      className={cn("border-b border-border/60 transition-colors hover:bg-accent/40", checked && "bg-primary/[0.04]")}
                    >
                      <td className="px-3 py-2.5">
                        <Checkbox checked={checked} onCheckedChange={() => toggleOne(n.id)} aria-label={`选择 ${n.name}`} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground">
                            <AppIcon icon={nodeIcon(n)} size={16} />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate font-medium">{n.name}</div>
                            {(n.region || n.tags) && (
                              <div className="truncate text-[11px] text-muted-foreground">
                                {[n.region, n.tags].filter(Boolean).join(" · ")}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant="soft" className="font-mono text-[11px]">
                          {n.protocol}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {n.host}:{n.port}
                      </td>
                      <td className="px-3 py-2.5">
                        {n.credential_name ? (
                          <span className="truncate">{n.credential_name}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {n.proxy_names && n.proxy_names.length > 0 ? (
                          <span className="truncate text-xs text-muted-foreground">{n.proxy_names.join(" → ")}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">直连</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {n.disabled ? (
                            <Badge variant="outline" className="rounded-full font-normal text-muted-foreground">
                              已停用
                            </Badge>
                          ) : (
                            <Badge variant="success" className="rounded-full font-normal">
                              启用
                            </Badge>
                          )}
                          {(n.requires_approval_for_connect || n.requires_approval_for_file_xfer) && (
                            <span title="需审批">
                              <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <NodeTestButton node={n} />
                          <Button variant="ghost" size="icon" className="h-8 w-8" title="编辑" onClick={() => setEditing(n)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <GrantWizard
                            fixedSubject={{ type: "node", id: n.id, name: n.name }}
                            trigger={
                              <Button variant="ghost" size="icon" className="h-8 w-8" title="授权访问">
                                <ShieldCheck className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="删除"
                            onClick={() => setDeleting(n)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}

      <NodeDetailPanel
        node={detailNode}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        status={detailNode ? nodeStatus.byId(detailNode.id) : null}
        checking={detailNode ? nodeStatus.isChecking(detailNode.id) : false}
        onRecheck={(id) => nodeStatus.request([id], true)}
        withSessions
      />

      {/* Edit */}
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

      {/* Delete */}
      {deleting && (
        <ConfirmDeleteDialog
          open
          onOpenChange={(v) => !v && setDeleting(null)}
          title={`删除节点「${deleting.name}」？`}
          description="删除后引用该节点的授权、会话历史不受影响，但用户将无法再连接它。"
          loading={removeMut.isPending}
          onConfirm={() => removeMut.mutate([deleting.id])}
        />
      )}
    </div>
  )
}

// Inline reachability test button used in each table row.
function NodeTestButton({ node }: { node: Node }) {
  const test = useMutation({
    mutationFn: () => nodeService.test(node.id),
    onSuccess: (r) => {
      if (r.ok) toast.success(`连通成功 · ${node.name}`, { description: `${r.mode?.toUpperCase()} · ${r.latency_ms}ms` })
      else toast.error(`连通失败 · ${node.name}`, { description: r.error })
    },
    onError: (e: Error) => toast.error("测试失败", { description: e.message }),
  })
  return (
    <Button variant="ghost" size="icon" className="h-8 w-8" title="测试连通性" disabled={test.isPending} onClick={() => test.mutate()}>
      {test.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
    </Button>
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

