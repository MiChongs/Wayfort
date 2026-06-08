"use client"

import * as React from "react"
import { VirtuosoGrid, type GridComponents } from "react-virtuoso"
import { cn } from "@/lib/utils"

export interface VirtualGridProps<T> {
  rows: T[]
  renderItem: (item: T, index: number) => React.ReactNode
  itemKey?: (item: T, index: number) => React.Key
  empty?: React.ReactNode
  /** Box height; the grid scrolls internally. */
  height?: number | string
  className?: string
  /** Tailwind classes for the responsive grid wrapper. */
  columnsClassName?: string
}

/**
 * VirtualGrid virtualises a responsive card grid with react-virtuoso's
 * VirtuosoGrid so large catalogs (chain templates…) recycle off-screen cards and
 * stay smooth. Mirrors VirtualTable's API. Per-card layout animation is dropped
 * under virtualization (recycled nodes can't carry it cleanly) — a CSS fade in
 * the card itself is the lightweight substitute.
 */
export function VirtualGrid<T>({
  rows,
  renderItem,
  itemKey,
  empty,
  height = "min(70vh, 640px)",
  className,
  columnsClassName = "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3",
}: VirtualGridProps<T>) {
  const components = React.useMemo<GridComponents>(
    () => ({
      List: React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<"div">>(
        function VGList({ className: c, ...props }, ref) {
          return <div ref={ref} {...props} className={cn(columnsClassName, c)} />
        },
      ),
      Item: ({ children, ...props }) => (
        <div {...props} className="min-w-0">
          {children}
        </div>
      ),
    }),
    [columnsClassName],
  )

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
        {empty ?? "无数据"}
      </div>
    )
  }

  return (
    <div className={cn("min-h-0", className)} style={{ height }}>
      <VirtuosoGrid
        data={rows}
        components={components}
        computeItemKey={itemKey ? (index, item) => itemKey(item as T, index) : undefined}
        itemContent={(index, item) => renderItem(item as T, index)}
        className="no-scrollbar h-full"
      />
    </div>
  )
}
