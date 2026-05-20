"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, Hash, Info, KeyRound } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dbService } from "@/lib/api/services"
import type { DBTableInfo } from "@/lib/api/types"
import { ResultGrid } from "./result-grid"

type Props = {
  nodeId: number
  table: DBTableInfo
  // Explicit database — PostgreSQL needs it to route to the right
  // per-catalog pool; MySQL uses it as the query default schema.
  database?: string
}

// BrowseTab — "click a table, see its rows" without writing SQL.
// Pagination is server-side (LIMIT / OFFSET); column-level order is
// piped to the backend via the rows endpoint so the order is stable
// across pages. The column metadata panel sits to the right with type
// + nullable + default + key flags.
export function BrowseTab({ nodeId, table, database }: Props) {
  const [pageSize, setPageSize] = React.useState(100)
  const [page, setPage] = React.useState(0)
  const [orderBy, setOrderBy] = React.useState<string | undefined>(undefined)
  const [orderDir, setOrderDir] = React.useState<"ASC" | "DESC">("ASC")

  // Reset paging when switching tables.
  React.useEffect(() => {
    setPage(0)
    setOrderBy(undefined)
    setOrderDir("ASC")
  }, [table.schema, table.name])

  const cols = useQuery({
    queryKey: ["db.cols", nodeId, database, table.schema, table.name],
    queryFn: () => dbService.columns(nodeId, table.schema, table.name, database),
    staleTime: 60_000,
  })
  const indexes = useQuery({
    queryKey: ["db.idx", nodeId, database, table.schema, table.name],
    queryFn: () => dbService.indexes(nodeId, table.schema, table.name, database),
    staleTime: 60_000,
  })
  const rows = useQuery({
    queryKey: ["db.rows", nodeId, database, table.schema, table.name, page, pageSize, orderBy, orderDir],
    queryFn: () =>
      dbService.rows(nodeId, table.schema, table.name, {
        limit: pageSize,
        offset: page * pageSize,
        order_by: orderBy,
        order_dir: orderBy ? orderDir : undefined,
        database,
      }),
    placeholderData: (prev) => prev,
  })

  const pkSet = React.useMemo(
    () => new Set(cols.data?.columns.filter((c) => c.is_primary_key).map((c) => c.name) ?? []),
    [cols.data]
  )

  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="border-b px-3 py-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="outline" className="font-mono text-[10px]">
              {table.kind}
            </Badge>
            <span className="font-medium truncate">
              <span className="text-muted-foreground">{table.schema}.</span>
              {table.name}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={page === 0 || rows.isFetching}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </Button>
            <span className="tabular-nums">第 {page + 1} 页</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={!rows.data?.truncated || rows.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(0) }}>
              <SelectTrigger className="h-7 text-xs w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[50, 100, 200, 500].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} 行
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <ResultGrid
            result={rows.data}
            loading={rows.isLoading}
            error={(rows.error as { message?: string })?.message}
            primaryKeys={pkSet}
            sortBy={orderBy}
            sortDir={orderDir}
            onSort={(c, d) => {
              setOrderBy(c)
              setOrderDir(d)
              setPage(0)
            }}
          />
        </div>
      </div>

      <aside className="w-72 shrink-0 border-l overflow-y-auto bg-card/30">
        <section className="p-3 border-b">
          <div className="text-xs font-medium mb-2 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" /> 列
          </div>
          <ul className="space-y-1">
            {cols.data?.columns.map((c) => (
              <li key={c.name} className="text-xs">
                <div className="flex items-center gap-1">
                  {c.is_primary_key && <KeyRound className="w-3 h-3 text-amber-600 shrink-0" />}
                  <span className="font-medium truncate">{c.name}</span>
                  {!c.nullable && (
                    <span className="text-[9px] uppercase text-muted-foreground">NN</span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono ml-1">
                  {c.type}
                  {c.default_value && <span className="ml-1">= {c.default_value}</span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="p-3">
          <div className="text-xs font-medium mb-2 flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5" /> 索引
          </div>
          {indexes.data?.indexes.length === 0 && (
            <div className="text-[10px] text-muted-foreground">无</div>
          )}
          <ul className="space-y-1.5">
            {indexes.data?.indexes.map((idx) => (
              <li key={idx.name} className="text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium truncate">{idx.name}</span>
                  {idx.is_primary && (
                    <Badge variant="secondary" className="text-[9px] px-1 py-0">PK</Badge>
                  )}
                  {idx.is_unique && !idx.is_primary && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0">UNIQUE</Badge>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">
                  ({idx.columns.join(", ")})
                </div>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  )
}
