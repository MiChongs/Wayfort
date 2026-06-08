// Reusable asset-tree builders. The workspace "我的资产" tree keeps its own
// view-specific builders (favorites/recent/protocols/…), but the group
// HIERARCHY shape — hang a flat node set on the asset-group tree — is shared by
// the 访问策略「按人看」view, which turns a grantee's reachable assets into the
// same real, multi-level tree instead of a flat list.

import type { AssetGroup, Node, NodeAccess } from "@/lib/api/types"

// One row of the access tree. Group/ungrouped rows are folders; node rows are
// leaves carrying the resolved Node plus the per-grantee access detail (actions
// / sources / expiry) so the row can render its grant context.
export type AccessTreeRow =
  | {
      kind: "group"
      id: string
      groupId: number
      label: string
      path: string
      total: number // reachable nodes in this group's whole subtree
      children: AccessTreeRow[]
    }
  | {
      kind: "ungrouped"
      id: string
      label: string
      total: number
      children: AccessTreeRow[]
    }
  | {
      kind: "node"
      id: string
      nodeId: number
      node?: Node
      access?: NodeAccess
      parentKey: string
    }

function byNodeName(nodeById: Map<number, Node>) {
  return (a: AccessTreeRow, b: AccessTreeRow) => {
    const an = a.kind === "node" ? nodeById.get(a.nodeId)?.name ?? "" : ""
    const bn = b.kind === "node" ? nodeById.get(b.nodeId)?.name ?? "" : ""
    return an.localeCompare(bn)
  }
}

// buildAccessTree hangs a grantee's reachable node set on the asset-group
// hierarchy. Empty groups (no reachable descendant) are pruned so the tree only
// shows branches that actually grant something. A node belonging to several
// groups appears under each (mirroring the workspace tree); nodes in no in-scope
// group land in a synthetic 未分组 folder. Leaf ids are namespaced by their
// parent so multi-membership stays unique for react-arborist.
export function buildAccessTree(
  groups: AssetGroup[],
  reach: NodeAccess[],
  nodeById: Map<number, Node>,
): AccessTreeRow[] {
  const accessByNode = new Map<number, NodeAccess>()
  for (const a of reach) accessByNode.set(a.node_id, a)

  const groupIdSet = new Set(groups.map((g) => g.id))
  const directMembers = new Map<number, number[]>()
  const ungrouped: number[] = []
  for (const a of reach) {
    const gids = (a.group_ids || []).filter((g) => groupIdSet.has(g))
    if (gids.length === 0) {
      ungrouped.push(a.node_id)
      continue
    }
    for (const gid of gids) {
      const arr = directMembers.get(gid) ?? []
      arr.push(a.node_id)
      directMembers.set(gid, arr)
    }
  }

  const childrenOf = new Map<number, AssetGroup[]>()
  for (const g of groups) {
    const key = g.parent_id != null && groupIdSet.has(g.parent_id) ? g.parent_id : 0
    const arr = childrenOf.get(key) ?? []
    arr.push(g)
    childrenOf.set(key, arr)
  }

  const subtreeTotal = new Map<number, number>()
  const computeTotal = (g: AssetGroup): number => {
    let n = (directMembers.get(g.id) ?? []).length
    for (const c of childrenOf.get(g.id) ?? []) n += computeTotal(c)
    subtreeTotal.set(g.id, n)
    return n
  }
  for (const g of childrenOf.get(0) ?? []) computeTotal(g)

  const makeNodeRow = (nid: number, parentKey: string): AccessTreeRow => ({
    kind: "node",
    id: `${parentKey}:n:${nid}`,
    nodeId: nid,
    node: nodeById.get(nid),
    access: accessByNode.get(nid),
    parentKey,
  })

  const makeGroup = (g: AssetGroup): AccessTreeRow | null => {
    if ((subtreeTotal.get(g.id) ?? 0) === 0) return null
    const key = `g:${g.id}`
    const childFolders = (childrenOf.get(g.id) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(makeGroup)
      .filter((x): x is AccessTreeRow => x !== null)
    const memberRows = (directMembers.get(g.id) ?? [])
      .map((nid) => makeNodeRow(nid, key))
      .sort(byNodeName(nodeById))
    return {
      kind: "group",
      id: key,
      groupId: g.id,
      label: g.name,
      path: g.path,
      total: subtreeTotal.get(g.id) ?? 0,
      children: [...childFolders, ...memberRows],
    }
  }

  const out: AccessTreeRow[] = (childrenOf.get(0) ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(makeGroup)
    .filter((x): x is AccessTreeRow => x !== null)

  if (ungrouped.length > 0) {
    out.push({
      kind: "ungrouped",
      id: "ungrouped",
      label: "未分组 / 直接授权",
      total: ungrouped.length,
      children: ungrouped
        .map((nid) => makeNodeRow(nid, "ungrouped"))
        .sort(byNodeName(nodeById)),
    })
  }
  return out
}

// collectGroupRowIds returns every folder id in an access forest — used to seed
// "everything expanded" so the grantee's reachable assets are visible at a glance.
export function collectGroupRowIds(rows: AccessTreeRow[]): string[] {
  const out: string[] = []
  const walk = (arr: AccessTreeRow[]) => {
    for (const r of arr) {
      if (r.kind === "group" || r.kind === "ungrouped") {
        out.push(r.id)
        walk(r.children)
      }
    }
  }
  walk(rows)
  return out
}

// childrenOfRow is the getChildren accessor for <TreeList>.
export function childrenOfRow(r: AccessTreeRow): AccessTreeRow[] | undefined {
  return r.kind === "node" ? undefined : r.children
}
