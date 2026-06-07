"use client"

import * as React from "react"
import { TableVirtuoso, type TableComponents } from "react-virtuoso"
import { cn } from "@/lib/utils"

export interface VirtualTableProps<T> {
  rows: T[]
  /** Sticky header cells — `<th>`s; they are wrapped in a `<tr>` for you. */
  header: React.ReactNode
  /** The `<td>` cells for one row. */
  renderRow: (item: T, index: number) => React.ReactNode
  className?: string
  empty?: React.ReactNode
}

/**
 * VirtualTable virtualises a `<table>` with react-virtuoso's TableVirtuoso so
 * thousand-row ops lists (processes, packages, connections…) stay smooth — only
 * the visible rows mount. The header stays sticky; rows recycle. Cells are plain
 * `<th>`/`<td>` so existing table styling carries over unchanged.
 *
 * Only `Table` and `TableHead` are themed (header gets a solid backdrop so
 * recycled rows don't bleed through); the rest uses react-virtuoso defaults so
 * streaming row updates never remount the virtualiser.
 */
export function VirtualTable<T>({ rows, header, renderRow, className, empty }: VirtualTableProps<T>) {
  const components = React.useMemo<TableComponents<T>>(
    () => ({
      Table: (props) => (
        <table
          {...props}
          className={cn(
            "w-full border-collapse text-[11px]",
            "[&_tbody_tr]:border-b [&_tbody_tr]:border-border/60",
            "[&_tbody_tr:hover]:bg-accent/40",
          )}
        />
      ),
      TableHead: React.forwardRef<HTMLTableSectionElement, React.ComponentPropsWithoutRef<"thead">>(
        function VirtualTableHead(props, ref) {
          return (
            <thead
              {...props}
              ref={ref}
              className="bg-card/95 text-left text-[10px] uppercase text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-card/80"
            />
          )
        },
      ),
    }),
    [],
  )

  if (rows.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        {empty ?? "无数据"}
      </div>
    )
  }

  return (
    <div className={cn("h-full min-h-0", className)}>
      <TableVirtuoso
        data={rows}
        components={components}
        fixedHeaderContent={() => <tr>{header}</tr>}
        itemContent={(index, item) => renderRow(item, index)}
        className="no-scrollbar h-full"
      />
    </div>
  )
}
