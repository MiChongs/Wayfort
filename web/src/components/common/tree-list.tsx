"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import {
  Tree,
  type CursorProps,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi,
} from "react-arborist"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"

// TreeList — hierarchical list built on **react-arborist** (the mainstream React
// tree library: virtualization, drag-to-reparent, keyboard nav, a11y are all
// the library's, no hand-rolled mechanics). This file is a thin adapter that
// preserves the original TreeList props so callers stay unchanged: callers own
// each row's content via `renderRow`; the library owns indent / chevron /
// keyboard / DnD / windowing.
//
// Mapping to react-arborist:
//   nodes/getId/getChildren → data / idAccessor / childrenAccessor
//   onMove(sourceId, targetId|null) ← onMove({dragIds, parentId})  (reparent)
//   controlled expandedIds ← TreeApi.open/close reconcile + onToggle
//   virtualize → windowed by default; height auto-fits content when off.

export interface TreeRowMeta {
  depth: number
  expanded: boolean
  hasChildren: boolean
  toggle: () => void
  focused: boolean
  dragging: boolean
  dropTarget: boolean
  /** True when multi-select is on (so renderRow can adjust layout). */
  selecting: boolean
  /** True when this row is in the current multi-selection. */
  selected: boolean
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
  /** Enter / double-click on a row. */
  onActivate?: (node: T) => void
  /** Enables drag-to-reparent. targetId === null means "move to top level". */
  onMove?: (sourceId: string, targetId: string | null) => void
  canDrag?: (node: T) => boolean
  /** @deprecated react-arborist drops at root natively; kept for prop compat. */
  rootDropLabel?: string
  indent?: number
  /** @deprecated indentation now comes from react-arborist; kept for prop compat. */
  showGuides?: boolean
  className?: string
  rowClassName?: (node: T, meta: TreeRowMeta) => string
  emptyHint?: React.ReactNode
  /** Windowed rendering for large trees. The host must give this component a
   *  bounded height. When false, the tree auto-sizes to its visible rows so the
   *  page scroll handles overflow (matches the old non-virtualized behaviour). */
  virtualize?: boolean
  /** Opt-in multi-select. Off by default → existing single-select callers are
   *  byte-for-byte unchanged. When on, a checkbox column appears and selection
   *  is driven entirely by it (row clicks never touch selection). */
  selectable?: boolean
  /** Controlled selection set (row ids). Omit to let it manage internally. */
  selectedIds?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
  /** Show the per-row checkbox column (default true when selectable). */
  showCheckbox?: boolean
  /** Folders / non-selectable rows return false → no checkbox, never selected. */
  canSelect?: (node: T) => boolean
}

const ROW_HEIGHT = 32
// Indent-guide rail offset: the chevron column is 20px wide, so its centre — and
// thus the vertical rail that descends from an ancestor — sits 10px in.
const GUIDE_OFFSET = 10
// Width of the optional leading checkbox column (h-5 w-5), so rails realign when
// multi-select is enabled.
const CHECKBOX_COL = 20

// DropCursor — the insertion indicator react-arborist shows between rows during
// a drag. A coral dot + hairline (ringed against the surface for separation),
// ending with the would-be parent indent so it reads as "drops here".
function DropCursor({ top, left, indent }: CursorProps) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 flex items-center"
      style={{ top: top - 1, left, right: indent }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_2px_var(--background)]" />
      <span className="h-0.5 flex-1 rounded-full bg-primary" />
    </div>
  )
}

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
  indent = 18,
  className,
  rowClassName,
  emptyHint,
  virtualize = false,
  selectable = false,
  selectedIds,
  onSelectedChange,
  showCheckbox = true,
  canSelect,
}: TreeListProps<T>) {
  const controlled = expandedIds !== undefined
  const [internalOpen, setInternalOpen] = React.useState<Set<string>>(
    () => new Set(defaultExpandedIds ?? []),
  )
  const openSet = controlled ? expandedIds! : internalOpen
  const setOpenSet = React.useCallback(
    (next: Set<string>) => {
      if (controlled) onExpandedChange?.(next)
      else setInternalOpen(next)
    },
    [controlled, onExpandedChange],
  )

  const dndActive = !!onMove
  const treeRef = React.useRef<TreeApi<T> | undefined>(undefined)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)

  // childrenAccessor: leaves → null. Empty arrays stay arrays only when DnD is
  // on (so an empty group is a valid drop target); otherwise they collapse to a
  // leaf (no chevron), matching the old `hasChildren = kids.length > 0`.
  const childrenAccessor = React.useCallback(
    (n: T): T[] | null => {
      const k = getChildren(n)
      if (k == null) return null
      if (k.length === 0) return dndActive ? [] : null
      return k
    },
    [getChildren, dndActive],
  )

  // Seed open state once on mount from the initial expansion set.
  const [initialOpenState] = React.useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {}
    for (const id of openSet) m[id] = true
    return m
  })

  // Every internal (expandable) node id — used to reconcile open state.
  const allInternalIds = React.useMemo(() => {
    const ids: string[] = []
    const walk = (arr: T[]) => {
      for (const n of arr) {
        const k = getChildren(n)
        if (k && k.length) {
          ids.push(getId(n))
          walk(k)
        }
      }
    }
    walk(nodes)
    return ids
  }, [nodes, getId, getChildren])

  // Count visible rows (respecting open state) so the non-virtualized tree can
  // size itself to its content.
  const visibleCount = React.useMemo(() => {
    let c = 0
    const walk = (arr: T[]) => {
      for (const n of arr) {
        c++
        const k = getChildren(n)
        if (k && k.length && openSet.has(getId(n))) walk(k)
      }
    }
    walk(nodes)
    return c
  }, [nodes, openSet, getId, getChildren])

  // Reconcile the library's open state to match `openSet`. Idempotent; guarded
  // so the open/close calls below can't feed back through onToggle into a loop.
  const syncing = React.useRef(false)
  React.useEffect(() => {
    const api = treeRef.current
    if (!api) return
    syncing.current = true
    for (const id of allInternalIds) {
      if (openSet.has(id)) api.open(id)
      else api.close(id)
    }
    syncing.current = false
  }, [openSet, allInternalIds])

  const onToggle = React.useCallback(
    (id: string) => {
      if (syncing.current) return
      const isOpen = treeRef.current?.get(id)?.isOpen ?? false
      const next = new Set(openSet)
      if (isOpen) next.add(id)
      else next.delete(id)
      // Skip when membership is unchanged — avoids identity-churn loops.
      const same = next.size === openSet.size && [...next].every((x) => openSet.has(x))
      if (!same) setOpenSet(next)
    },
    [openSet, setOpenSet],
  )

  // ----- Multi-select (opt-in). react-arborist owns the live selection state
  // (so rows re-render the instant a checkbox toggles); we mirror it out to the
  // controlled `selectedIds` and reconcile external changes back in. Both
  // directions short-circuit on set-equality, which is the loop-breaker (same
  // technique as the open-state above). Selection is driven ONLY by the checkbox
  // column — the custom Node renderer wires no click-to-select.
  const onSelectMirror = React.useCallback(
    (nodes: NodeApi<T>[]) => {
      if (!selectable) return
      const next = new Set<string>()
      for (const n of nodes) {
        if (canSelect && !canSelect(n.data)) continue
        next.add(n.id)
      }
      const cur = selectedIds ?? new Set<string>()
      const same = next.size === cur.size && [...next].every((x) => cur.has(x))
      if (!same) onSelectedChange?.(next)
    },
    [selectable, canSelect, selectedIds, onSelectedChange],
  )

  React.useEffect(() => {
    if (!selectable) return
    const api = treeRef.current
    if (!api) return
    const target = selectedIds ?? new Set<string>()
    const cur = api.selectedIds ?? new Set<string>()
    const same = target.size === cur.size && [...target].every((x) => cur.has(x))
    if (!same) api.setSelection({ ids: [...target], anchor: null, mostRecent: null })
  }, [selectable, selectedIds])

  // Measure container height for the virtualized (bounded-height) case.
  const [measuredH, setMeasuredH] = React.useState(0)
  React.useLayoutEffect(() => {
    if (!virtualize) return
    const el = wrapRef.current
    if (!el) return
    const update = () => setMeasuredH(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [virtualize])

  const treeHeight = virtualize
    ? measuredH || 360
    : Math.max(ROW_HEIGHT, visibleCount * ROW_HEIGHT) + 4

  // Stable node renderer — reads live callbacks from a ref so its identity never
  // changes (a fresh component type each render would remount every row).
  const ctx = React.useRef({ renderRow, rowClassName, onActivate, selectable, showCheckbox, canSelect })
  ctx.current = { renderRow, rowClassName, onActivate, selectable, showCheckbox, canSelect }
  const Node = React.useCallback((props: NodeRendererProps<T>) => {
    const { node, style, dragHandle } = props
    const { renderRow, rowClassName, onActivate, selectable, showCheckbox, canSelect } = ctx.current
    const selectableRow = !!selectable && (canSelect ? canSelect(node.data) : true)
    const meta: TreeRowMeta = {
      depth: node.level,
      expanded: node.isOpen,
      hasChildren: node.isInternal,
      toggle: () => node.toggle(),
      focused: node.isFocused,
      dragging: node.isDragging,
      dropTarget: node.willReceiveDrop,
      selecting: !!selectable,
      selected: node.isSelected,
    }
    return (
      <div
        ref={dragHandle}
        style={style}
        onDoubleClick={() => onActivate?.(node.data)}
        className={cn(
          "group/tree relative flex h-full items-center rounded-md outline-none",
          "transition-[background-color,box-shadow] duration-150",
          node.isDragging && "opacity-40",
          node.willReceiveDrop
            ? "bg-primary/[0.08] ring-2 ring-inset ring-primary/55"
            : node.isSelected
              ? "bg-primary/[0.06] hover:bg-primary/[0.09]"
              : "hover:bg-muted/60",
          node.isFocused && !node.willReceiveDrop && "ring-2 ring-inset ring-ring/35",
          rowClassName?.(node.data, meta),
        )}
      >
        {selectable && showCheckbox !== false && (
          <span
            className={cn(
              "relative z-[2] grid h-5 w-5 shrink-0 place-items-center",
              !selectableRow && "pointer-events-none opacity-0",
            )}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {selectableRow && (
              <Checkbox
                checked={node.isSelected}
                onCheckedChange={() => node.selectMulti()}
                aria-label={node.isSelected ? "取消选择" : "选择"}
                className="h-3.5 w-3.5"
              />
            )}
          </span>
        )}
        {/* Indent-guide rails — one subtle vertical hairline per ancestor level,
            descending from each ancestor's chevron column (VS Code-style). They
            brighten slightly on row hover so the active branch reads clearly. */}
        {node.level > 0 &&
          Array.from({ length: node.level }).map((_, k) => (
            <span
              key={k}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-border/70 transition-colors group-hover/tree:bg-border"
              // Shift the rails right by the checkbox column width so they keep
              // descending from each ancestor's chevron when multi-select is on.
              style={{ left: indent * k + GUIDE_OFFSET + (selectable && showCheckbox !== false ? CHECKBOX_COL : 0) }}
            />
          ))}

        {node.isInternal ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              node.toggle()
            }}
            className="relative z-[1] grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
            aria-label={node.isOpen ? "折叠" : "展开"}
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-150 ease-out",
                node.isOpen && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}
        <div className="relative z-[1] min-w-0 flex-1">{renderRow(node.data, meta)}</div>
      </div>
    )
  }, [])

  if (nodes.length === 0) {
    return (
      <div ref={wrapRef} className={cn("select-none", virtualize && "h-full", className)}>
        {emptyHint}
      </div>
    )
  }

  return (
    <div ref={wrapRef} className={cn("select-none", virtualize && "h-full", className)}>
      <Tree<T>
        ref={treeRef}
        data={nodes}
        idAccessor={getId}
        childrenAccessor={childrenAccessor}
        openByDefault={false}
        initialOpenState={initialOpenState}
        onToggle={onToggle}
        width="100%"
        height={treeHeight}
        rowHeight={ROW_HEIGHT}
        indent={indent}
        renderCursor={DropCursor}
        disableMultiSelection={!selectable}
        onSelect={selectable ? onSelectMirror : undefined}
        disableEdit
        disableDrag={dndActive ? (canDrag ? (d) => !canDrag(d) : false) : true}
        disableDrop={({ parentNode, dragNodes }) =>
          dragNodes.some((dn) => dn.id === parentNode?.id || dn.isAncestorOf(parentNode))
        }
        onMove={
          onMove
            ? ({ dragIds, parentId }) => {
                for (const id of dragIds) onMove(id, parentId)
              }
            : undefined
        }
      >
        {Node}
      </Tree>
    </div>
  )
}

// Re-exported for callers that referenced the type directly.
export type { NodeApi as TreeNodeApi }
