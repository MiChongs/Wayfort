"use client"

import * as React from "react"
import { TableVirtuoso, type TableComponents } from "react-virtuoso"
import { cn } from "@/lib/utils"

export type Column<T> = {
  header: string
  cell: (row: T) => React.ReactNode
  className?: string
}

export function DataTable<T extends { id?: string | number }>({
  columns,
  rows,
  loading,
  empty = "暂无数据",
  rowKey,
  virtualize,
  height = "min(70vh, 620px)",
}: {
  columns: Column<T>[]
  rows: T[] | undefined
  loading?: boolean
  empty?: string
  rowKey?: (row: T, idx: number) => React.Key
  // Virtualize the body for large lists — only the visible rows mount. The table
  // gets its own internal scroll at `height` (keeping DataTable's text-sm look).
  virtualize?: boolean
  height?: number | string
}) {
  // Virtualize only once the list is big enough to matter — small lists keep the
  // natural page-scroll table (no awkward fixed-height box).
  if (virtualize && (rows?.length ?? 0) > 40) {
    return (
      <VirtualDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        empty={empty}
        rowKey={rowKey}
        height={height}
      />
    )
  }

  return (
    <div className="rounded-lg border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted text-xs uppercase text-muted-foreground">
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={cn("text-left px-3 py-2 font-medium", c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={columns.length} className="text-center text-muted-foreground py-8">加载中…</td>
            </tr>
          )}
          {!loading && (rows?.length ?? 0) === 0 && (
            <tr>
              <td colSpan={columns.length} className="text-center text-muted-foreground py-8">{empty}</td>
            </tr>
          )}
          {(rows || []).map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : (r.id ?? i)} className="border-t hover:bg-accent/30">
              {columns.map((c, j) => (
                <td key={j} className={cn("px-3 py-2", c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VirtualDataTable<T extends { id?: string | number }>({
  columns,
  rows,
  loading,
  empty,
  rowKey,
  height,
}: {
  columns: Column<T>[]
  rows: T[] | undefined
  loading?: boolean
  empty: string
  rowKey?: (row: T, idx: number) => React.Key
  height: number | string
}) {
  const components = React.useMemo<TableComponents<T>>(
    () => ({
      Table: (props) => <table {...props} className="w-full border-collapse text-sm" />,
      TableHead: React.forwardRef<HTMLTableSectionElement, React.ComponentPropsWithoutRef<"thead">>(
        function VDTHead(props, ref) {
          return (
            <thead
              {...props}
              ref={ref}
              className="bg-muted text-xs uppercase text-muted-foreground"
            />
          )
        },
      ),
      TableRow: (props) => <tr {...props} className="border-t hover:bg-accent/30" />,
    }),
    [],
  )

  if (!loading && (rows?.length ?? 0) === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border text-sm text-muted-foreground"
        style={{ height }}
      >
        {loading ? "加载中…" : empty}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border" style={{ height }}>
      <TableVirtuoso
        data={rows || []}
        components={components}
        fixedHeaderContent={() => (
          <tr>
            {columns.map((c, i) => (
              <th key={i} className={cn("bg-muted px-3 py-2 text-left font-medium", c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        )}
        computeItemKey={(i, r) => (rowKey ? rowKey(r, i) : (r.id ?? i))}
        itemContent={(_i, r) =>
          columns.map((c, j) => (
            <td key={j} className={cn("px-3 py-2", c.className)}>
              {c.cell(r)}
            </td>
          ))
        }
        className="no-scrollbar h-full"
      />
    </div>
  )
}
