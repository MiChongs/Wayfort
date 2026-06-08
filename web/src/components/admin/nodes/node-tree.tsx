"use client"

// Tree view for the nodes admin page — the table's sibling. Organises the same
// (already filtered) node set by asset-group hierarchy or by tag, with the
// shared multi-select + live status dots. Selection is kept as numeric node ids
// (the page's source of truth) and adapted to/from the TreeList string set so
// switching table↔tree never loses the selection.

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { FolderPlus } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { AppIcon } from "@/components/icons/app-icon"
import { TreeList } from "@/components/common/tree-list"
import { assetGroupService } from "@/lib/api/services"
import { nodeIcon } from "@/lib/icons/protocol"
import { cn } from "@/lib/utils"
import type { AssetGroup, Node } from "@/lib/api/types"

export type AssetSelection = { kind: "group" | "node"; id: number }

export type NodeTreeRow =
  | { kind: "group"; id: string; label: string; path?: string; total: number; children: NodeTreeRow[] }
  | { kind: "node"; id: string; nodeId: number; node: Node; parentKey: string }

function sortNodes(a: Node, b: Node) {
  return a.name.localeCompare(b.name)
}

// Group-dimension tree: real parent_id hierarchy + member leaves (intersected
// with the visible node set), ungrouped nodes in a trailing folder.
function buildByGroup(nodes: Node[], groups: AssetGroup[]): NodeTreeRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const groupIdSet = new Set(groups.map((g) => g.id))
  const childrenOf = new Map<number, AssetGroup[]>()
  for (const g of groups) {
    const key = g.parent_id != null && groupIdSet.has(g.parent_id) ? g.parent_id : 0
    const arr = childrenOf.get(key) ?? []
    arr.push(g)
    childrenOf.set(key, arr)
  }
  const grouped = new Set<number>()

  const makeFolder = (g: AssetGroup): NodeTreeRow => {
    const key = `g:${g.id}`
    const childFolders = (childrenOf.get(g.id) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(makeFolder)
    const memberLeaves: NodeTreeRow[] = []
    for (const nid of g.node_ids ?? []) {
      const n = byId.get(nid)
      if (n) {
        grouped.add(n.id)
        memberLeaves.push({ kind: "node", id: `${key}:n:${n.id}`, nodeId: n.id, node: n, parentKey: key })
      }
    }
    memberLeaves.sort((a, b) => sortNodes((a as { node: Node }).node, (b as { node: Node }).node))
    let total = memberLeaves.length
    for (const c of childFolders) total += c.kind === "group" ? c.total : 0
    return { kind: "group", id: key, label: g.name, path: g.path, total, children: [...childFolders, ...memberLeaves] }
  }

  const out: NodeTreeRow[] = (childrenOf.get(0) ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(makeFolder)

  const ungrouped = nodes.filter((n) => !grouped.has(n.id)).sort(sortNodes)
  if (ungrouped.length > 0) {
    out.push({
      kind: "group",
      id: "ungrouped",
      label: "未分组",
      total: ungrouped.length,
      children: ungrouped.map((n) => ({ kind: "node", id: `ungrouped:n:${n.id}`, nodeId: n.id, node: n, parentKey: "ungrouped" })),
    })
  }
  return out
}

// Tag-dimension tree: one folder per managed tag (multi-membership → repeats),
// untagged nodes trailing.
function buildByTag(nodes: Node[]): NodeTreeRow[] {
  const buckets = new Map<string, Node[]>()
  const untagged: Node[] = []
  for (const n of nodes) {
    const names = (n.tag_list?.map((t) => t.name) ?? (n.tags || "").split(",").map((s) => s.trim())).filter(Boolean)
    if (names.length === 0) {
      untagged.push(n)
      continue
    }
    for (const t of names) {
      const arr = buckets.get(t) ?? []
      arr.push(n)
      buckets.set(t, arr)
    }
  }
  const out: NodeTreeRow[] = [...buckets.keys()]
    .sort()
    .map((t) => {
      const members = (buckets.get(t) ?? []).slice().sort(sortNodes)
      const key = `tag:${t}`
      return {
        kind: "group" as const,
        id: key,
        label: t,
        total: members.length,
        children: members.map((n) => ({ kind: "node" as const, id: `${key}:n:${n.id}`, nodeId: n.id, node: n, parentKey: key })),
      }
    })
  if (untagged.length > 0) {
    out.push({
      kind: "group",
      id: "untagged",
      label: "未打标签",
      total: untagged.length,
      children: untagged.sort(sortNodes).map((n) => ({ kind: "node", id: `untagged:n:${n.id}`, nodeId: n.id, node: n, parentKey: "untagged" })),
    })
  }
  return out
}

function collectFolderIds(rows: NodeTreeRow[]): string[] {
  const out: string[] = []
  const walk = (arr: NodeTreeRow[]) => {
    for (const r of arr) if (r.kind === "group") { out.push(r.id); walk(r.children) }
  }
  walk(rows)
  return out
}

export function NodeTree({
  nodes,
  groups,
  treeBy,
  selectedNodeIds,
  onSelectedNodeIds,
  selected,
  onSelect,
  onNewSubgroup,
  onChanged,
}: {
  nodes: Node[]
  groups: AssetGroup[]
  treeBy: "group" | "tag"
  selectedNodeIds: Set<number>
  onSelectedNodeIds: (next: Set<number>) => void
  selected: AssetSelection | null
  onSelect: (sel: AssetSelection) => void
  onNewSubgroup: (parentId: number) => void
  onChanged?: () => void
}) {
  const tree = React.useMemo(
    () => (treeBy === "group" ? buildByGroup(nodes, groups) : buildByTag(nodes)),
    [nodes, groups, treeBy],
  )
  const expandedSeed = React.useMemo(() => collectFolderIds(tree), [tree])

  // Adapt numeric node selection ↔ TreeList string ids. A node may appear under
  // multiple folders; selecting any instance selects the node.
  const idToNode = React.useMemo(() => {
    const m = new Map<string, number>()
    const walk = (arr: NodeTreeRow[]) => {
      for (const r of arr) {
        if (r.kind === "node") m.set(r.id, r.nodeId)
        else walk(r.children)
      }
    }
    walk(tree)
    return m
  }, [tree])

  const selectedStringIds = React.useMemo(() => {
    const s = new Set<string>()
    for (const [rowId, nodeId] of idToNode) if (selectedNodeIds.has(nodeId)) s.add(rowId)
    return s
  }, [idToNode, selectedNodeIds])

  const onSelectedChange = (next: Set<string>) => {
    const ids = new Set<number>()
    for (const rowId of next) {
      const nid = idToNode.get(rowId)
      if (nid != null) ids.add(nid)
    }
    onSelectedNodeIds(ids)
  }

  // Drag a node onto a group folder → join that group (multi-membership kept);
  // drag it out to the root → leave its current group. Only in the group view.
  const dropMut = useMutation({
    mutationFn: async ({ nodeId, fromGroup, toGroup }: { nodeId: number; fromGroup: number | null; toGroup: number | null }) => {
      if (toGroup != null) await assetGroupService.addNodesBatch(toGroup, [nodeId])
      else if (fromGroup != null) await assetGroupService.removeNodesBatch(fromGroup, [nodeId])
    },
    onSuccess: (_d, v) => { toast.success(v.toGroup != null ? "已加入分组" : "已移出分组"); onChanged?.() },
    onError: (e: { message?: string }) => toast.error("操作失败", { description: e?.message }),
  })
  const onMove =
    treeBy === "group"
      ? (sourceId: string, targetId: string | null) => {
          const parts = sourceId.split(":n:")
          if (parts.length !== 2) return
          const nodeId = Number(parts[1])
          const srcPrefix = parts[0]
          const fromGroup = srcPrefix.startsWith("g:") ? Number(srcPrefix.slice(2)) : null
          const toGroup = targetId && targetId.startsWith("g:") ? Number(targetId.slice(2)) : null
          if (toGroup === fromGroup) return
          dropMut.mutate({ nodeId, fromGroup, toGroup })
        }
      : undefined

  return (
    <TreeList<NodeTreeRow>
      nodes={tree}
      getId={(r) => r.id}
      getChildren={(r) => (r.kind === "group" ? r.children : undefined)}
      defaultExpandedIds={expandedSeed}
      selectable
      selectedIds={selectedStringIds}
      onSelectedChange={onSelectedChange}
      canSelect={(r) => r.kind === "node"}
      onMove={onMove}
      canDrag={(r) => r.kind === "node"}
      indent={16}
      rowClassName={(r) =>
        selected &&
        ((r.kind === "group" && selected.kind === "group" && r.id === `g:${selected.id}`) ||
          (r.kind === "node" && selected.kind === "node" && r.nodeId === selected.id))
          ? "bg-primary/[0.08] ring-1 ring-inset ring-primary/30"
          : ""
      }
      renderRow={(r) =>
        r.kind === "group" ? (
          <GroupRow row={r} onSelect={onSelect} onNewSubgroup={onNewSubgroup} />
        ) : (
          <NodeRow node={r.node} onSelect={onSelect} />
        )
      }
    />
  )
}

function GroupRow({
  row,
  onSelect,
  onNewSubgroup,
}: {
  row: Extract<NodeTreeRow, { kind: "group" }>
  onSelect: (sel: AssetSelection) => void
  onNewSubgroup: (parentId: number) => void
}) {
  // Real asset groups have a "g:<id>" id; the synthetic 未分组 / 未打标签 / tag
  // folders don't map to a group entity, so they only expand (no inspector).
  const gid = row.id.startsWith("g:") ? Number(row.id.slice(2)) : null
  return (
    <div className="group/grouprow flex items-center gap-1.5 py-1 pr-1 text-sm">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left font-medium disabled:cursor-default"
        onClick={() => gid != null && onSelect({ kind: "group", id: gid })}
        disabled={gid == null}
      >
        {row.label}
      </button>
      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{row.total}</span>
      {gid != null && (
        <button
          type="button"
          title="新建子组"
          onClick={(e) => {
            e.stopPropagation()
            onNewSubgroup(gid)
          }}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover/grouprow:opacity-100"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function NodeRow({ node, onSelect }: { node: Node; onSelect: (sel: AssetSelection) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect({ kind: "node", id: node.id })}
      className={cn("flex w-full items-center gap-2 py-1 pr-1 text-left text-sm", node.disabled && "opacity-60")}
    >
      <AppIcon icon={nodeIcon(node)} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{node.host}:{node.port}</span>
      <Badge variant="soft" className="hidden shrink-0 font-mono text-[10px] md:inline-flex">{node.protocol}</Badge>
      {node.disabled && <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">停用</Badge>}
    </button>
  )
}
