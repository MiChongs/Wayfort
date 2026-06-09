"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, RefreshCcw, Search, X } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { assetGroupService, meService, tagService } from "@/lib/api/services"
import type { AssetGroup, MyCatalog, MyCatalogFolder, MyCatalogPlacement, Node } from "@/lib/api/types"
import type { DesktopBackend } from "@/lib/desktop/types"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { TreeList } from "@/components/common/tree-list"
import { NodeDetailPanel } from "@/components/asset-tree/node-detail"
import { AssetCommandPalette } from "@/components/asset-tree/asset-command-palette"
import { TreeStatBar } from "@/components/asset-tree/tree-stat-bar"
import {
  FolderContent,
  LeafContent,
  type TreeFolder,
  type TreeItem,
  type TreeLeaf,
} from "./AssetTreeNode"
import { AssetTreeViewSwitcher } from "./AssetTreeViewSwitcher"
import { metaOf } from "./protocolMeta"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

type Props = {
  onOpenTab: (node: Node, protocol: Protocol, rdpBackend?: DesktopBackend) => void
}

export function AssetTree({ onOpenTab }: Props) {
  const qc = useQueryClient()
  const treeView = useWorkspaceStore((s) => s.treeView)
  const setTreeView = useWorkspaceStore((s) => s.setTreeView)
  const [q, setQ] = React.useState("")
  const [detailNode, setDetailNode] = React.useState<Node | null>(null)
  const [detailOpen, setDetailOpen] = React.useState(false)

  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const favorites = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })
  const recents = useQuery({ queryKey: ["me", "recents"], queryFn: () => meService.recentNodes(50) })
  const groups = useQuery({ queryKey: ["asset-groups"], queryFn: assetGroupService.list })
  const tags = useQuery({ queryKey: ["tags"], queryFn: tagService.list })
  const catalogs = useQuery({ queryKey: ["me", "catalogs"], queryFn: meService.catalogs })

  const allNodes: Node[] = nodes.data?.nodes ?? []
  const favIds = new Set(favorites.data?.node_ids ?? [])

  const openDetail = React.useCallback((n: Node) => {
    setDetailNode(n)
    setDetailOpen(true)
  }, [])

  const filteredNodes = React.useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return allNodes
    return allNodes.filter((n) =>
      [n.name, n.host, n.description, n.region, n.tags, n.protocol]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(k)),
    )
  }, [allNodes, q])

  const tree: TreeItem[] = React.useMemo(() => {
    switch (treeView) {
      case "favorites":
        return buildFavorites(filteredNodes, favIds)
      case "recent":
        return buildRecent(filteredNodes, recents.data?.recent ?? [])
      case "directory":
        return buildCatalogTree(catalogs.data?.catalogs ?? [], filteredNodes, favIds)
      case "groups":
        return buildGroups(filteredNodes, groups.data?.asset_groups ?? [], favIds)
      case "tags":
        return buildTags(filteredNodes, tags.data?.tags?.map((t) => t.name) ?? [])
      case "protocols":
        return buildProtocols(filteredNodes)
      case "all":
      default:
        return buildAll(filteredNodes, favIds)
    }
  }, [filteredNodes, favIds, treeView, recents.data, groups.data, tags.data, catalogs.data])

  const toggleFav = useMutation({
    mutationFn: async (node: Node) => {
      if (favIds.has(node.id)) await meService.removeFavorite(node.id)
      else await meService.addFavorite(node.id)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me", "favorites"] })
    },
    onError: (e: { message?: string }) => toast.error("更新收藏失败", { description: e?.message }),
  })

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["me", "nodes"] })
    void qc.invalidateQueries({ queryKey: ["me", "favorites"] })
    void qc.invalidateQueries({ queryKey: ["me", "recents"] })
    void qc.invalidateQueries({ queryKey: ["asset-groups"] })
    void qc.invalidateQueries({ queryKey: ["tags"] })
    void qc.invalidateQueries({ queryKey: ["me", "catalogs"] })
  }

  const loading =
    nodes.isLoading ||
    (treeView === "groups" && groups.isLoading) ||
    (treeView === "directory" && catalogs.isLoading)
  const empty = !loading && tree.length === 0

  return (
    <div className="h-full flex flex-col bg-sidebar text-sidebar-foreground">
      <div className="px-3 pt-3 pb-1 flex items-center justify-between gap-2 shrink-0">
        <h2 className="text-sm font-semibold">我的资产</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={refreshAll}
          title="刷新资产数据"
        >
          <RefreshCcw className={cn("w-3.5 h-3.5", nodes.isFetching && "animate-spin")} />
        </Button>
      </div>
      <div className="px-3 pb-1 shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 名称 / IP / 标签…"
            className="h-7 text-xs pl-7 pr-7"
          />
          {q && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setQ("")}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
      <AssetTreeViewSwitcher value={treeView} onChange={setTreeView} />
      <div className="px-2 shrink-0">
        <TreeStatBar total={allNodes.length} matched={filteredNodes.length} />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden py-1 px-1">
        {loading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 px-3 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载资产…
          </div>
        ) : empty ? (
          <div className="text-xs text-muted-foreground px-3 py-6 text-center">
            {q ? "没有匹配的资产" : "这里还没有可见资产"}
          </div>
        ) : (
          // `key` forces a fresh expansion state (all folders open) whenever the
          // view or search changes — matching the old per-folder defaultOpen.
          <TreeList<TreeItem>
            key={`${treeView}:${q}`}
            virtualize
            nodes={tree}
            getId={(it) => it.id}
            getChildren={(it) => (it.type === "folder" ? it.children : undefined)}
            defaultExpandedIds={collectFolderIds(tree)}
            indent={14}
            renderRow={(it) =>
              it.type === "folder" ? (
                <FolderContent folder={it} />
              ) : (
                <LeafContent
                  leaf={it}
                  onOpenTab={onOpenTab}
                  onToggleFavorite={(n) => toggleFav.mutate(n)}
                  onOpenDetail={openDetail}
                />
              )
            }
          />
        )}
      </div>

      <NodeDetailPanel node={detailNode} open={detailOpen} onOpenChange={setDetailOpen} />
      <AssetCommandPalette nodes={allNodes} onSelect={openDetail} />
    </div>
  )
}

// ---------- builders ----------

function leaf(node: Node, favIds: Set<number>, prefix: string): TreeLeaf {
  return { type: "leaf", id: `${prefix}:${node.id}`, node, isFavorite: favIds.has(node.id) }
}

// All folder ids in a forest — used to seed "everything expanded".
function collectFolderIds(items: TreeItem[]): string[] {
  const out: string[] = []
  const walk = (arr: TreeItem[]) => {
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

function buildFavorites(nodes: Node[], favIds: Set<number>): TreeItem[] {
  const fav = nodes.filter((n) => favIds.has(n.id))
  return [
    {
      type: "folder",
      id: "fav-root",
      label: "收藏夹",
      count: fav.length,
      defaultOpen: true,
      children: fav.map((n) => leaf(n, favIds, "fav")),
    },
  ]
}

function buildRecent(nodes: Node[], recent: { node_id: number; last_used_at: string; hits: number }[]): TreeItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const ordered = recent.map((r) => byId.get(r.node_id)).filter(Boolean) as Node[]
  return [
    {
      type: "folder",
      id: "recent-root",
      label: "最近访问",
      count: ordered.length,
      defaultOpen: true,
      children: ordered.map((n) => leaf(n, new Set(), "recent")),
    },
  ]
}

function buildAll(nodes: Node[], favIds: Set<number>): TreeItem[] {
  return [
    {
      type: "folder",
      id: "all-root",
      label: "全部",
      count: nodes.length,
      defaultOpen: true,
      children: nodes.map((n) => leaf(n, favIds, "all")),
    },
  ]
}

function buildProtocols(nodes: Node[]): TreeItem[] {
  // Group by node.protocol; map known ones to the workspace protocol meta
  // so the folder icon stays consistent.
  const buckets = new Map<string, Node[]>()
  for (const n of nodes) {
    if (!buckets.has(n.protocol)) buckets.set(n.protocol, [])
    buckets.get(n.protocol)!.push(n)
  }
  const out: TreeItem[] = []
  for (const [proto, group] of [...buckets.entries()].sort()) {
    const meta = (() => {
      try {
        return metaOf(proto as Protocol)
      } catch {
        return undefined
      }
    })()
    out.push({
      type: "folder",
      id: `proto:${proto}`,
      label: proto.toUpperCase(),
      count: group.length,
      defaultOpen: true,
      icon: meta?.icon,
      children: group.map((n) => leaf(n, new Set(), `proto-${proto}`)),
    })
  }
  return out
}

function buildTags(nodes: Node[], tagNames: string[]): TreeItem[] {
  const buckets = new Map<string, Node[]>()
  const untagged: Node[] = []
  for (const n of nodes) {
    const tags = (n.tags || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    if (tags.length === 0) {
      untagged.push(n)
      continue
    }
    for (const t of tags) {
      if (!buckets.has(t)) buckets.set(t, [])
      buckets.get(t)!.push(n)
    }
  }
  const allTagSet = new Set([...tagNames, ...buckets.keys()])
  const out: TreeItem[] = []
  for (const t of [...allTagSet].sort()) {
    const group = buckets.get(t) ?? []
    out.push({
      type: "folder",
      id: `tag:${t}`,
      label: t,
      count: group.length,
      defaultOpen: true,
      children: group.map((n) => leaf(n, new Set(), `tag-${t}`)),
    })
  }
  if (untagged.length > 0) {
    out.push({
      type: "folder",
      id: "tag:untagged",
      label: "未打标签",
      count: untagged.length,
      defaultOpen: false,
      children: untagged.map((n) => leaf(n, new Set(), "tag-untagged")),
    })
  }
  return out
}

function buildGroups(nodes: Node[], groups: AssetGroup[], favIds: Set<number>): TreeItem[] {
  // The /asset-groups list endpoint enriches each group with its member node
  // IDs. We now honour the real parent_id hierarchy: each group folder nests
  // its child group folders ABOVE its own member leaves. Nodes in no group land
  // in DEFAULT. Folder children are computed against the (already filtered)
  // visible node set.
  const byNode = new Map(nodes.map((n) => [n.id, n]))
  const groupIds = new Set(groups.map((g) => g.id))
  const childrenOf = new Map<number, AssetGroup[]>()
  for (const g of groups) {
    const key = g.parent_id != null && groupIds.has(g.parent_id) ? g.parent_id : 0
    const arr = childrenOf.get(key) ?? []
    arr.push(g)
    childrenOf.set(key, arr)
  }
  const grouped = new Set<number>()

  const makeFolder = (g: AssetGroup): TreeFolder => {
    const childFolders = (childrenOf.get(g.id) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(makeFolder)
    const memberLeaves: TreeLeaf[] = []
    for (const nid of g.node_ids ?? []) {
      const n = byNode.get(nid)
      if (n) {
        grouped.add(n.id)
        memberLeaves.push(leaf(n, favIds, `group-${g.id}`))
      }
    }
    return {
      type: "folder",
      id: `group:${g.id}`,
      label: g.name,
      count: memberLeaves.length,
      defaultOpen: true,
      children: [...childFolders, ...memberLeaves],
    }
  }

  const out: TreeItem[] = (childrenOf.get(0) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(makeFolder)

  const ungrouped = nodes.filter((n) => !grouped.has(n.id))
  if (ungrouped.length > 0) {
    out.push({
      type: "folder",
      id: "group:default",
      label: "DEFAULT",
      count: ungrouped.length,
      defaultOpen: true,
      children: ungrouped.map((n) => leaf(n, favIds, "group-default")),
    })
  }
  return out
}

function countLeavesIn(items: TreeItem[]): number {
  let c = 0
  for (const it of items) {
    if (it.type === "leaf") c++
    else c += countLeavesIn(it.children)
  }
  return c
}

// 我的目录：管理员分配的自定义授权目录。后端已按可连资产过滤并裁剪空文件夹；
// 这里再按搜索词过滤（join 到可见节点集），并裁掉因搜索而清空的文件夹。每个目录
// 自身渲染为一个顶层文件夹，内部沿 parent_id 还原层级，叶子是放置的资产。
function buildCatalogTree(catalogs: MyCatalog[], nodes: Node[], favIds: Set<number>): TreeItem[] {
  const byNode = new Map(nodes.map((n) => [n.id, n]))
  const out: TreeItem[] = []
  const ordered = (a: { sort_order?: number; name: string }, b: { sort_order?: number; name: string }) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)

  for (const cat of catalogs) {
    const folderIds = new Set(cat.folders.map((f) => f.id))
    const childrenOf = new Map<number, MyCatalogFolder[]>()
    for (const f of cat.folders) {
      const key = f.parent_id != null && folderIds.has(f.parent_id) ? f.parent_id : 0
      const arr = childrenOf.get(key) ?? []
      arr.push(f)
      childrenOf.set(key, arr)
    }
    const plByFolder = new Map<number, MyCatalogPlacement[]>()
    for (const p of cat.placements) {
      const arr = plByFolder.get(p.folder_id) ?? []
      arr.push(p)
      plByFolder.set(p.folder_id, arr)
    }

    const makeFolder = (f: MyCatalogFolder): TreeFolder | null => {
      const childFolders = (childrenOf.get(f.id) ?? [])
        .sort(ordered)
        .map(makeFolder)
        .filter((x): x is TreeFolder => x !== null)
      const leaves: TreeLeaf[] = []
      for (const p of plByFolder.get(f.id) ?? []) {
        const n = byNode.get(p.node_id)
        if (n) leaves.push(leaf(n, favIds, `cat-${cat.id}-${f.id}`))
      }
      const children = [...childFolders, ...leaves]
      if (children.length === 0) return null // pruned away by the search filter
      return {
        type: "folder",
        id: `cat:${cat.id}:f:${f.id}`,
        label: f.name,
        count: leaves.length,
        defaultOpen: true,
        children,
      }
    }

    const roots = (childrenOf.get(0) ?? [])
      .sort(ordered)
      .map(makeFolder)
      .filter((x): x is TreeFolder => x !== null)
    if (roots.length === 0) continue // whole catalog empty after filtering
    out.push({
      type: "folder",
      id: `cat:${cat.id}`,
      label: cat.name,
      count: countLeavesIn(roots),
      defaultOpen: true,
      children: roots,
    })
  }
  return out
}
