"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  Edit,
  FileCode,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { dbService } from "@/lib/api/services"
import type { DBCapabilities, DBTableInfo } from "@/lib/api/types"
import { ResultGrid } from "./result-grid"
import { RowEditor, deleteRow } from "./row-editor"
import { StructureTab } from "./structure-tab"

// downloadExport — open the streaming /db/export URL in a new tab. The
// browser handles the download via Content-Disposition; auth rides on
// the ?token=… helper (same shape session recording downloads use).
function downloadExport(nodeId: number, table: DBTableInfo, format: "csv" | "jsonl" | "sql", database?: string) {
  const url = dbService.exportURL(nodeId, { schema: table.schema, table: table.name, format, database })
  const a = document.createElement("a")
  a.href = url
  a.target = "_blank"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  toast.success(`开始导出 ${table.schema}.${table.name} → ${format.toUpperCase()}`)
}

type Props = {
  nodeId: number
  table: DBTableInfo
  database?: string
  // Phase 22 — adapter Capabilities. When unset (still loading) all
  // affordances render so the user doesn't see the UI flash from
  // disabled to enabled. Once present the buttons / tabs gate.
  caps?: DBCapabilities
}

// BrowseTab — sub-tabbed: Data (paginated rows + row edit) and
// Structure (DDL + FKs + stats). The whole component reloads from
// scratch when (database, schema, table) changes.
export function BrowseTab({ nodeId, table, database, caps }: Props) {
  const [sub, setSub] = React.useState<"data" | "structure">("data")
  // Capability flags default ON when caps still loading (avoids the
  // "buttons appear then disable" flash). After caps arrives they
  // strictly gate every write-class / metadata affordance.
  const canEdit = caps ? caps.row_edits : true
  const canExport = caps ? caps.export : true
  const hasStructure = caps ? (caps.table_ddl || caps.foreign_keys || caps.table_stats) : true

  const [pageSize, setPageSize] = React.useState(100)
  const [page, setPage] = React.useState(0)
  const [orderBy, setOrderBy] = React.useState<string | undefined>(undefined)
  const [orderDir, setOrderDir] = React.useState<"ASC" | "DESC">("ASC")

  // Reset paging when switching tables.
  React.useEffect(() => {
    setPage(0)
    setOrderBy(undefined)
    setOrderDir("ASC")
    setSub("data")
  }, [table.schema, table.name, database])

  const cols = useQuery({
    queryKey: ["db.cols", nodeId, database, table.schema, table.name],
    queryFn: () => dbService.columns(nodeId, table.schema, table.name, database),
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

  // Row editor dialog state. mode='insert' means new row; 'edit' means
  // a pre-filled row identified by PK + initial column values.
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editorMode, setEditorMode] = React.useState<"edit" | "insert">("edit")
  const [editorRow, setEditorRow] = React.useState<Record<string, unknown> | undefined>()

  const openInsert = () => {
    setEditorMode("insert")
    setEditorRow(undefined)
    setEditorOpen(true)
  }
  const openEdit = (rowIdx: number) => {
    if (!rows.data || !cols.data) return
    const r = rows.data.rows[rowIdx]
    const obj: Record<string, unknown> = {}
    rows.data.columns.forEach((col, i) => { obj[col.name] = r[i] })
    setEditorMode("edit")
    setEditorRow(obj)
    setEditorOpen(true)
  }
  const doDelete = async (rowIdx: number) => {
    if (!rows.data || !cols.data) return
    const r = rows.data.rows[rowIdx]
    const obj: Record<string, unknown> = {}
    rows.data.columns.forEach((col, i) => { obj[col.name] = r[i] })
    const pkValues = cols.data.columns
      .filter((c) => c.is_primary_key)
      .map((c) => obj[c.name])
    const summary = pkValues.length ? `主键 = ${pkValues.join(", ")}` : "无主键 — 操作将被后端拒绝"
    if (!confirm(`确认删除该行？\n${summary}`)) return
    try {
      const r2 = await deleteRow(nodeId, database, table, cols.data.columns, obj)
      toast.success(`已删除 ${r2.affected} 行`)
      await rows.refetch()
    } catch (e) {
      toast.error((e as Error).message ?? "删除失败")
    }
  }

  const noPK = (cols.data?.columns.filter((c) => c.is_primary_key).length ?? 0) === 0

  return (
    <Tabs value={sub} onValueChange={(v) => setSub(v as "data" | "structure")} className="flex-1 min-h-0 flex flex-col">
      <div className="border-b px-3 py-1.5 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="outline" className="font-mono text-[10px]">{table.kind}</Badge>
          <span className="font-medium truncate text-sm">
            <span className="text-muted-foreground">{table.schema}.</span>
            {table.name}
          </span>
          <TabsList className="ml-2">
            <TabsTrigger value="data" className="gap-1 text-xs">
              <Database className="w-3.5 h-3.5" /> 数据
            </TabsTrigger>
            {hasStructure && (
              <TabsTrigger value="structure" className="gap-1 text-xs">
                <FileCode className="w-3.5 h-3.5" /> 结构
              </TabsTrigger>
            )}
          </TabsList>
        </div>
        {sub === "data" && (
          <div className="flex items-center gap-1.5 text-xs">
            {canEdit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={openInsert}
                disabled={!cols.data}
                title={noPK ? "（无主键 — 后端会拒绝定位单行；写入仍可行）" : ""}
              >
                <Plus className="w-3.5 h-3.5" /> 新增
              </Button>
            )}
            {canExport && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs">
                  <Download className="w-3.5 h-3.5" /> 导出
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="text-[10px] text-muted-foreground">
                  服务端流式下载（无分页）
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={() => downloadExport(nodeId, table, "csv", database)}>
                  CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadExport(nodeId, table, "jsonl", database)}>
                  JSON Lines
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadExport(nodeId, table, "sql", database)}>
                  SQL INSERT
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )}
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
        )}
      </div>

      <TabsContent value="data" className="flex-1 min-h-0 m-0 flex">
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
          rowActions={
            // Phase 25 — per-row Edit/Delete only rendered when the
            // adapter advertises row_edits. OLAP engines (StarRocks/
            // Doris) and views without unique PKs hide the column
            // entirely so the grid doesn't waste a slot for dead icons.
            canEdit
              ? (rowIdx) => (
                  <span className="inline-flex items-center gap-0.5">
                    <button
                      type="button"
                      className="p-1 hover:text-primary"
                      title="编辑此行"
                      onClick={() => openEdit(rowIdx)}
                    >
                      <Edit className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      className="p-1 hover:text-destructive"
                      title="删除此行"
                      onClick={() => doDelete(rowIdx)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                )
              : undefined
          }
        />
      </TabsContent>

      <TabsContent value="structure" className="flex-1 min-h-0 m-0">
        <StructureTab nodeId={nodeId} database={database} table={table} caps={caps} />
      </TabsContent>

      {cols.data && (
        <RowEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          nodeId={nodeId}
          database={database}
          table={table}
          columns={cols.data.columns}
          mode={editorMode}
          initial={editorRow}
          onSaved={() => rows.refetch()}
        />
      )}
    </Tabs>
  )
}
