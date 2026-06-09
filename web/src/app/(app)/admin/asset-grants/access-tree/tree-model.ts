// Pure logic for the authorisation-tree workbench: flatten the folder/item tree
// into a display list, project a drag onto a (parent, depth) target for the
// @dnd-kit sortable tree (reorder + reparent in one gesture), and compute the
// effective permission of an item after folder inheritance.

import type { ComponentType } from "react"
import type { AccessFolder, AccessItem, GranteeKind, Node } from "@/lib/api/types"
import { PRESETS, actionLabel } from "@/lib/access/permissions"

// The object that owns a tree, plus the catalogues used to pick one.
export type Owner = { type: GranteeKind; id: number; name: string }
export interface OwnerCat {
  key: GranteeKind
  label: string
  icon?: ComponentType<{ className?: string }>
  items: { id: number; name: string; sub?: string }[]
}

// dnd payloads shared by the library (external drag) and the sortable tree.
export type DragData =
  | { kind: "lib"; nodeId: number; label: string }
  | { kind: "row"; rowId: string; rowKind: FlatKind; label: string }

export type FlatKind = "folder" | "item"
export interface FlatRow {
  id: string // "folder:<id>" | "item:<id>"
  kind: FlatKind
  fid?: number
  folder?: AccessFolder
  item?: AccessItem
  node?: Node
  parentId: string | null
  depth: number
  hasChildren: boolean
  collapsed: boolean
}

const fId = (id: number) => `folder:${id}`
const iId = (id: number) => `item:${id}`

const bySort = (a: { sort_order?: number; name?: string }, b: { sort_order?: number; name?: string }) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.name ?? "").localeCompare(b.name ?? "")

// flatten produces the visible rows in display order (folders before their item
// leaves; collapsed subtrees omitted).
export function flatten(
  folders: AccessFolder[],
  items: AccessItem[],
  nodeById: Map<number, Node>,
  collapsed: Set<number>,
): FlatRow[] {
  const folderIds = new Set(folders.map((f) => f.id))
  const childFolders = new Map<number, AccessFolder[]>()
  for (const f of folders) {
    const key = f.parent_id != null && folderIds.has(f.parent_id) ? f.parent_id : 0
    const arr = childFolders.get(key) ?? []
    arr.push(f)
    childFolders.set(key, arr)
  }
  const itemsByFolder = new Map<number, AccessItem[]>()
  for (const it of items) {
    const arr = itemsByFolder.get(it.folder_id) ?? []
    arr.push(it)
    itemsByFolder.set(it.folder_id, arr)
  }
  const out: FlatRow[] = []
  const walk = (parentFolderId: number, depth: number, parentRowId: string | null) => {
    const fs = (childFolders.get(parentFolderId) ?? []).slice().sort(bySort)
    for (const f of fs) {
      const its = (itemsByFolder.get(f.id) ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      const subFs = childFolders.get(f.id) ?? []
      const hasChildren = subFs.length > 0 || its.length > 0
      const isCollapsed = collapsed.has(f.id)
      out.push({ id: fId(f.id), kind: "folder", fid: f.id, folder: f, parentId: parentRowId, depth, hasChildren, collapsed: isCollapsed })
      if (!isCollapsed) {
        walk(f.id, depth + 1, fId(f.id))
        for (const it of its) {
          out.push({ id: iId(it.id), kind: "item", item: it, node: nodeById.get(it.node_id), parentId: fId(f.id), depth: depth + 1, hasChildren: false, collapsed: false })
        }
      }
    }
  }
  walk(0, 0, null)
  return out
}

// ids of all rows in the collapsed subtree of a folder (so we hide them while
// dragging the folder, matching dnd-kit's removeChildrenOf).
export function removeChildrenOf(rows: FlatRow[], ids: string[]): FlatRow[] {
  const exclude = new Set<string>()
  const excludeParents = new Set(ids)
  for (const r of rows) {
    if (r.parentId && (excludeParents.has(r.parentId) || exclude.has(r.parentId))) {
      if (r.hasChildren) excludeParents.add(r.id)
      exclude.add(r.id)
    }
  }
  return rows.filter((r) => !exclude.has(r.id))
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max))

export interface Projection {
  depth: number
  parentId: string | null // parent FOLDER row id ("folder:<id>") or null = root
}

// getProjection mirrors the dnd-kit sortable-tree example, with one constraint:
// an item (asset) can never be a root row and never be a parent — it must land
// under a folder. Returns null when the drop is invalid (e.g. item at root).
export function getProjection(
  rows: FlatRow[],
  activeId: string,
  overId: string,
  dragOffsetX: number,
  indent: number,
): Projection | null {
  const overIndex = rows.findIndex((r) => r.id === overId)
  const activeIndex = rows.findIndex((r) => r.id === activeId)
  if (overIndex < 0 || activeIndex < 0) return null
  const active = rows[activeIndex]
  const newRows = arrayMoveLite(rows, activeIndex, overIndex)
  const previous = newRows[overIndex - 1]
  const next = newRows[overIndex + 1]
  const projectedDepth = active.depth + Math.round(dragOffsetX / indent)
  const maxDepth = previous ? (previous.kind === "folder" ? previous.depth + 1 : previous.depth) : 0
  const minDepth = next ? next.depth : 0
  let depth = clamp(projectedDepth, minDepth, maxDepth)

  const getParentId = (): string | null => {
    if (depth === 0 || !previous) return null
    if (depth === previous.depth) return previous.parentId
    if (depth > previous.depth) return previous.kind === "folder" ? previous.id : previous.parentId
    const candidate = newRows
      .slice(0, overIndex)
      .reverse()
      .find((r) => r.depth === depth)?.parentId
    return candidate ?? null
  }
  let parentId = getParentId()

  // Constraint: an item must hang under a folder.
  if (active.kind === "item") {
    if (parentId === null || !parentId.startsWith("folder:")) {
      // snap to the nearest preceding folder
      const folderAbove = newRows.slice(0, overIndex).reverse().find((r) => r.kind === "folder")
      if (!folderAbove) return null
      parentId = folderAbove.id
      depth = Math.max(1, folderAbove.depth + 1)
    }
  } else {
    // a folder's parent must be a folder (or root)
    if (parentId !== null && !parentId.startsWith("folder:")) parentId = null
  }
  return { depth, parentId }
}

function arrayMoveLite<T>(arr: T[], from: number, to: number): T[] {
  const copy = arr.slice()
  const [m] = copy.splice(from, 1)
  copy.splice(to, 0, m)
  return copy
}

// ---- effective permission (after folder inheritance) ----

export interface Eff {
  actions: string[]
  validTo: string | null
  inheritedActions: boolean
  inheritedValid: boolean
}

export function effectiveForItem(item: AccessItem, folderById: Map<number, AccessFolder>): Eff {
  let actions = (item.actions ?? "").split(",").filter(Boolean)
  let inheritedActions = false
  let validTo = item.valid_to ?? null
  let inheritedValid = false
  if (actions.length === 0 || validTo == null) {
    // walk folder chain
    let cur: AccessFolder | undefined = folderById.get(item.folder_id)
    let guard = 0
    while (cur && guard++ < 64) {
      if (actions.length === 0 && cur.actions) {
        actions = cur.actions.split(",").filter(Boolean)
        inheritedActions = true
      }
      if (validTo == null && cur.valid_to) {
        validTo = cur.valid_to
        inheritedValid = true
      }
      if (actions.length > 0 && validTo != null) break
      cur = cur.parent_id != null ? folderById.get(cur.parent_id) : undefined
    }
  }
  if (actions.length === 0) actions = ["connect"]
  return { actions, validTo, inheritedActions, inheritedValid }
}

export function presetLabel(actions: string[]): string {
  const key = actions.slice().sort().join(",")
  const p = PRESETS.find((x) => x.actions.slice().sort().join(",") === key)
  return p ? p.label : actions.map(actionLabel).join(" · ")
}

// ---- insight totals for the preview strip ----

export interface Insight {
  assets: number // distinct connectable nodes
  byAction: Record<string, number>
  expiring: number // items with an effective expiry
}

export function computeInsight(items: AccessItem[], folderById: Map<number, AccessFolder>): Insight {
  const nodes = new Set<number>()
  const byAction: Record<string, number> = {}
  let expiring = 0
  for (const it of items) {
    nodes.add(it.node_id)
    const eff = effectiveForItem(it, folderById)
    for (const a of eff.actions) byAction[a] = (byAction[a] ?? 0) + 1
    if (eff.validTo) expiring++
  }
  return { assets: nodes.size, byAction, expiring }
}
