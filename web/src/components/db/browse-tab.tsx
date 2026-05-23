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
import { Input } from "@/components/ui/input"
import { ResultGrid } from "./result-grid"
import { RowEditor, deleteRow, coerceCell } from "./row-editor"
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
  // Phase 30 — server-side text filter (LIKE across text columns).
  // We debounce the input so each keystroke doesn't re-fetch.
  const [filterDraft, setFilterDraft] = React.useState("")
  const [filter, setFilter] = React.useState("")
  React.useEffect(() => {
    const t = setTimeout(() => {
      setFilter(filterDraft.trim())
      setPage(0)
    }, 350)
    return () => clearTimeout(t)
  }, [filterDraft])

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
    queryKey: ["db.rows", nodeId, database, table.schema, table.name, page, pageSize, orderBy, orderDir, filter],
    queryFn: () =>
      dbService.rows(nodeId, table.schema, table.name, {
        limit: pageSize,
        offset: page * pageSize,
        order_by: orderBy,
        order_dir: orderBy ? orderDir : undefined,
        database,
        filter: filter || undefined,
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

  // Phase 30c — multi-row selection for bulk delete. Set lives in the
  // BrowseTab so it survives page changes (the new page resets it;
  // selection across pages is intentionally NOT supported — too easy
  // to mass-delete the wrong rows when you can't see them).
  const [selected, setSelected] = React.useState<Set<number>>(new Set())
  React.useEffect(() => { setSelected(new Set()) }, [page, table.schema, table.name, filter])
  const toggleRow = React.useCallback((idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }, [])
  const toggleAll = React.useCallback((on: boolean) => {
    if (!rows.data) return
    if (on) setSelected(new Set(rows.data.rows.map((_, i) => i)))
    else setSelected(new Set())
  }, [rows.data])
  const doBulkDelete = React.useCallback(async () => {
    if (!rows.data || !cols.data || selected.size === 0) return
    const pkCols = cols.data.columns.filter((c) => c.is_primary_key)
    if (pkCols.length === 0) {
      toast.error("表没有主键，无法定位行")
      return
    }
    if (!confirm(`确认删除选中的 ${selected.size} 行？\n（按主键 ${pkCols.map((c) => c.name).join(", ")} 逐行 DELETE，第一条失败即停止）`)) return
    const rowsList = rows.data.rows
    const colsList = rows.data.columns
    let ok = 0
    let failed: string | null = null
    for (const idx of Array.from(selected).sort((a, b) => a - b)) {
      const r = rowsList[idx]
      const obj: Record<string, unknown> = {}
      colsList.forEach((col, i) => { obj[col.name] = r[i] })
      try {
        await deleteRow(nodeId, database, table, cols.data.columns, obj)
        ok++
      } catch (e) {
        failed = (e as Error).message ?? "未知错误"
        break
      }
    }
    if (failed) {
      toast.error(`批量删除中止：已删除 ${ok} 行；最后一条失败 — ${failed}`)
    } else {
      toast.success(`已批量删除 ${ok} 行`)
    }
    setSelected(new Set())
    await rows.refetch()
  }, [rows, cols.data, nodeId, database, table, selected])

  // Phase 25 — inline cell edit. Non-PK columns are editable; PK cells
  // intentionally stay read-only (the back-end UpdateRow uses them as
  // the WHERE key, mutating them in-place would require a separate
  // "update key" path).
  const editableColumnSet = React.useMemo(
    () => new Set((cols.data?.columns ?? [])
      .filter((c) => !c.is_primary_key)
      .map((c) => c.name)),
    [cols.data],
  )

  // saveCellEdit handles double-click → Enter on a non-PK cell. It
  // builds a single-column UPDATE keyed on the row's PKs and re-fetches
  // the page on success so the new value lands in the grid.
  const saveCellEdit = React.useCallback(
    async (rowIdx: number, columnName: string, newRaw: string | null) => {
      if (!rows.data || !cols.data) throw new Error("数据未就绪")
      const r = rows.data.rows[rowIdx]
      const obj: Record<string, unknown> = {}
      rows.data.columns.forEach((col, i) => { obj[col.name] = r[i] })
      const pkCols = cols.data.columns.filter((c) => c.is_primary_key)
      if (pkCols.length === 0) {
        toast.error("表没有主键，无法定位单行")
        throw new Error("missing PK")
      }
      const colMeta = cols.data.columns.find((c) => c.name === columnName)
      if (!colMeta) throw new Error(`column not found: ${columnName}`)
      const coerced = newRaw === null ? null : coerceCell(newRaw, colMeta.type)
      await dbService.rowUpdate(
        nodeId, table.schema, table.name,
        { columns: pkCols.map((c) => c.name), values: pkCols.map((c) => obj[c.name]) },
        [columnName], [coerced],
        { database },
      )
      toast.success(`已更新 ${columnName}`, { duration: 1500 })
      await rows.refetch()
    },
    [rows, cols.data, nodeId, table.schema, table.name, database],
  )

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
            {/* Phase 30 — server-side filter. Empty → unfiltered. Backend
                builds a multi-column LIKE WHERE across text-shaped cols. */}
            <div className="relative">
              <Input
                value={filterDraft}
                onChange={(e) => setFilterDraft(e.target.value)}
                placeholder="搜索（服务端 LIKE）"
                className="h-7 text-xs w-48 pr-7"
              />
              {filterDraft && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-destructive"
                  onClick={() => setFilterDraft("")}
                  title="清空搜索"
                >
                  ×
                </button>
              )}
            </div>
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
            {canEdit && selected.size > 0 && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={doBulkDelete}
                title="逐行 DELETE 选中的所有行"
              >
                <Trash2 className="w-3.5 h-3.5" /> 删除 {selected.size}
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
          // Phase 25 — inline cell edit. Only enabled when the adapter
          // advertises row_edits AND the table has at least one PK to
          // anchor the UPDATE WHERE.
          onCellEdit={canEdit && !noPK ? saveCellEdit : undefined}
          editableColumns={canEdit && !noPK ? editableColumnSet : undefined}
          // Phase 30c — multi-row selection for bulk delete. Off when
          // the engine forbids row edits or the table has no PK to
          // anchor each DELETE.
          selectable={canEdit && !noPK}
          selected={selected}
          onToggleRow={toggleRow}
          onToggleAll={toggleAll}
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
