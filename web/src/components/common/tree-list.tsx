"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

// TreeList — a custom, dependency-free hierarchical list. It owns the structural
// chrome (indent guides, the expand chevron, keyboard navigation, and optional
// drag-to-reparent); callers own each row's content via `renderRow`. Works for
// any forest: pass roots + id/children accessors. Used by the asset-group
// manager (with drag-reparent) and the workspace asset tree (read-only).

export interface TreeRowMeta {
  depth: number
  expanded: boolean
  hasChildren: boolean
  toggle: () => void
  focused: boolean
  dragging: boolean
  dropTarget: boolean
}

export interface TreeListProps<T> {
  nodes: T[]
  getId: (node: T) => string
  getChildren: (node: T) => T[] | undefined
  renderRow: (node: T, meta: TreeRowMeta) => React.ReactNode
  /** Controlled expansion. Omit to let the tree manage it from defaultExpandedIds. */
  expandedIds?: Set<string>
  onExpandedChange?: (next: Set<string>) => void
  defaultExpandedIds?: string[]
  /** Enter / double-click / Space on a row. */
  onActivate?: (node: T) => void
  /** Enables drag-to-reparent. targetId === null means "move to top level". */
  onMove?: (sourceId: string, targetId: string | null) => void
  canDrag?: (node: T) => boolean
  rootDropLabel?: string
  indent?: number
  showGuides?: boolean
  className?: string
  rowClassName?: (node: T, meta: TreeRowMeta) => string
  emptyHint?: React.ReactNode
}

const ROOT = "__root__"

export function TreeList<T>({
  nodes,
  getId,
  getChildren,
  renderRow,
  expandedIds,
  onExpandedChange,
  defaultExpandedIds,
  onActivate,
  onMove,
  canDrag,
  rootDropLabel = "移到顶层",
  indent = 18,
  showGuides = true,
  className,
  rowClassName,
  emptyHint,
}: TreeListProps<T>) {
  const controlled = expandedIds !== undefined
  const [internalExpanded, setInternalExpanded] = React.useState<Set<string>>(
    () => new Set(defaultExpandedIds ?? []),
  )
  const expanded = controlled ? expandedIds! : internalExpanded
  const setExpanded = React.useCallback(
    (next: Set<string>) => {
      if (controlled) onExpandedChange?.(next)
      else setInternalExpanded(next)
    },
    [controlled, onExpandedChange],
  )
  const toggle = React.useCallback(
    (id: string) => {
      const next = new Set(expanded)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setExpanded(next)
    },
    [expanded, setExpanded],
  )

  // Flatten the visible rows (respecting expansion) once per render.
  const flat = React.useMemo(() => {
    const out: { node: T; id: string; depth: number; hasChildren: boolean; parentId: string | null }[] = []
    const walk = (arr: T[], depth: number, parentId: string | null) => {
      for (const n of arr) {
        const id = getId(n)
        const kids = getChildren(n) ?? []
        const hasChildren = kids.length > 0
        out.push({ node: n, id, depth, hasChildren, parentId })
        if (hasChildren && expanded.has(id)) walk(kids, depth + 1, id)
      }
    }
    walk(nodes, 0, null)
    return out
  }, [nodes, expanded, getId, getChildren])

  const [focusId, setFocusId] = React.useState<string | null>(null)
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [overId, setOverId] = React.useState<string | null>(null)
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>())

  // Descendant ids of the dragged node (incl. itself) — invalid drop targets.
  const blockedDrop = React.useMemo(() => {
    if (!dragId) return new Set<string>()
    const find = (arr: T[]): T | null => {
      for (const n of arr) {
        if (getId(n) === dragId) return n
        const hit = find(getChildren(n) ?? [])
        if (hit) return hit
      }
      return null
    }
    const root = find(nodes)
    const ids = new Set<string>()
    const collect = (n: T) => {
      ids.add(getId(n))
      for (const c of getChildren(n) ?? []) collect(c)
    }
    if (root) collect(root)
    return ids
  }, [dragId, nodes, getId, getChildren])

  function focusRow(id: string | null) {
    setFocusId(id)
    if (id) rowRefs.current.get(id)?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent, idx: number) {
    const row = flat[idx]
    if (!row) return
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        focusRow(flat[Math.min(idx + 1, flat.length - 1)]?.id ?? null)
        break
      case "ArrowUp":
        e.preventDefault()
        focusRow(flat[Math.max(idx - 1, 0)]?.id ?? null)
        break
      case "ArrowRight":
        e.preventDefault()
        if (row.hasChildren && !expanded.has(row.id)) toggle(row.id)
        else if (row.hasChildren) focusRow(flat[idx + 1]?.id ?? null)
        break
      case "ArrowLeft":
        e.preventDefault()
        if (row.hasChildren && expanded.has(row.id)) toggle(row.id)
        else if (row.parentId) focusRow(row.parentId)
        break
      case "Enter":
      case " ":
        e.preventDefault()
        onActivate?.(row.node)
        break
      case "Home":
        e.preventDefault()
        focusRow(flat[0]?.id ?? null)
        break
      case "End":
        e.preventDefault()
        focusRow(flat[flat.length - 1]?.id ?? null)
        break
    }
  }

  const dndActive = !!onMove
  const empty = flat.length === 0

  return (
    <div
      role="tree"
      className={cn("select-none", className)}
      onDragOver={
        dndActive
          ? (e) => {
              // Background (not over a row) → root drop.
              e.preventDefault()
              setOverId(ROOT)
            }
          : undefined
      }
      onDrop={
        dndActive
          ? (e) => {
              e.preventDefault()
              if (dragId) onMove?.(dragId, null)
              setDragId(null)
              setOverId(null)
            }
          : undefined
      }
    >
      {dndActive && dragId && (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setOverId(ROOT)
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onMove?.(dragId, null)
            setDragId(null)
            setOverId(null)
          }}
          className={cn(
            "mb-1 rounded-md border border-dashed px-3 py-1.5 text-center text-xs transition-colors",
            overId === ROOT
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground",
          )}
        >
          {rootDropLabel}
        </div>
      )}

      {empty && emptyHint}

      {flat.map((row, idx) => {
        const isExpanded = expanded.has(row.id)
        const meta: TreeRowMeta = {
          depth: row.depth,
          expanded: isExpanded,
          hasChildren: row.hasChildren,
          toggle: () => toggle(row.id),
          focused: focusId === row.id,
          dragging: dragId === row.id,
          dropTarget: overId === row.id,
        }
        const canDropHere = dndActive && dragId !== null && !blockedDrop.has(row.id)
        const draggable = dndActive && (canDrag ? canDrag(row.node) : true)
        const pad = 6 + row.depth * indent

        return (
          <div
            key={row.id}
            ref={(el) => {
              if (el) rowRefs.current.set(row.id, el)
              else rowRefs.current.delete(row.id)
            }}
            role="treeitem"
            aria-expanded={row.hasChildren ? isExpanded : undefined}
            aria-level={row.depth + 1}
            tabIndex={focusId === row.id || (focusId === null && idx === 0) ? 0 : -1}
            draggable={draggable}
            onFocus={() => setFocusId(row.id)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            onDoubleClick={() => onActivate?.(row.node)}
            onDragStart={
              draggable
                ? (e) => {
                    e.stopPropagation()
                    setDragId(row.id)
                    e.dataTransfer.effectAllowed = "move"
                    try {
                      e.dataTransfer.setData("text/plain", row.id)
                    } catch {
                      /* some browsers require a payload */
                    }
                  }
                : undefined
            }
            onDragEnd={() => {
              setDragId(null)
              setOverId(null)
            }}
            onDragOver={
              dndActive
                ? (e) => {
                    if (!canDropHere) return
                    e.preventDefault()
                    e.stopPropagation()
                    setOverId(row.id)
                  }
                : undefined
            }
            onDragLeave={
              dndActive
                ? (e) => {
                    e.stopPropagation()
                    setOverId((cur) => (cur === row.id ? null : cur))
                  }
                : undefined
            }
            onDrop={
              dndActive
                ? (e) => {
                    if (!canDropHere) return
                    e.preventDefault()
                    e.stopPropagation()
                    if (dragId) onMove?.(dragId, row.id)
                    setDragId(null)
                    setOverId(null)
                  }
                : undefined
            }
            className={cn(
              "group/tree relative flex items-center rounded-md outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring/40",
              meta.dragging && "opacity-50",
              meta.dropTarget && canDropHere
                ? "bg-primary/10 ring-1 ring-primary/40"
                : "hover:bg-accent/60",
              rowClassName?.(row.node, meta),
            )}
            style={{ paddingLeft: pad }}
          >
            {/* Indent guides (one vertical line per ancestor level). */}
            {showGuides &&
              Array.from({ length: row.depth }).map((_, k) => (
                <span
                  key={k}
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 border-l border-border/40"
                  style={{ left: 6 + k * indent + 7 }}
                />
              ))}

            {/* Chevron (or a spacer to keep leaf rows aligned). */}
            {row.hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(row.id)
                }}
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                aria-label={isExpanded ? "折叠" : "展开"}
              >
                <ChevronRight
                  className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")}
                />
              </button>
            ) : (
              <span className="h-5 w-5 shrink-0" />
            )}

            <div className="min-w-0 flex-1">{renderRow(row.node, meta)}</div>
          </div>
        )
      })}
    </div>
  )
}
