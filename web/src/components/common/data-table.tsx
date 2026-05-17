"use client"

import * as React from "react"
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
}: {
  columns: Column<T>[]
  rows: T[] | undefined
  loading?: boolean
  empty?: string
  rowKey?: (row: T, idx: number) => React.Key
}) {
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
