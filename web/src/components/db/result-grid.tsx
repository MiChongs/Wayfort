"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, BarChart3, Check, Copy, Download, FileJson, KeyRound, Loader2, Maximize2, X } from "lucide-react"
import type { DBQueryResult } from "@/lib/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

type Props = {
  result?: DBQueryResult
  loading?: boolean
  error?: string
  // Optional column-level pin (primary key columns get highlighted).
  primaryKeys?: Set<string>
  // Sort state lives outside the grid so the page can drive a server-
  // side ORDER BY rather than re-sort in JS. When omitted the grid
  // does client-side sorting on the visible page only.
  sortBy?: string
  sortDir?: "ASC" | "DESC"
  onSort?: (col: string, dir: "ASC" | "DESC") => void
  // Optional row-end action slot (rendered next to the inspect button).
  // BrowseTab passes Edit + Delete icons keyed on the row's PK; the SQL
  // result grid leaves it undefined so freeform query results stay
  // read-only.
  rowActions?: (rowIdx: number) => React.ReactNode
  // Phase 25 — inline per-cell edit. When provided, double-click on a
  // non-PK cell opens an in-place input. Enter saves; Escape / blur with
  // unchanged value cancels. The handler must perform the UPDATE and
  // reject on failure so the cell can revert visually.
  //
  // editableColumns gates which columns accept double-click; PKs are
  // intentionally excluded by the caller (BrowseTab) so the row stays
  // addressable. When undefined no cell is editable.
  onCellEdit?: (rowIdx: number, columnName: string, newRaw: string | null) => Promise<void>
  editableColumns?: Set<string>
  // Phase 30c — multi-row selection. When `selectable` is true, a
  // leading checkbox column is rendered; the caller controls the
  // selection set externally so toolbar-level "Delete N" wiring stays
  // in one place. `selected` is the row-index set; toggling fires
  // `onToggleRow` (single) or `onToggleAll` (header).
  selectable?: boolean
  selected?: Set<number>
  onToggleRow?: (rowIdx: number) => void
  onToggleAll?: (next: boolean) => void
  // Phase 30f — column header → stats popover. When provided, a small
  // chart icon next to each header opens the popover with that column
  // pre-selected. Alt-click on the header text also triggers it as a
  // power-user keyboard-light path.
  onColumnStats?: (columnName: string, anchor: HTMLElement) => void
}

// ResultGrid — paginated/server-sortable result table. Handles JSON /
// long-text expansion via a row inspector dialog, column-level filter
// (client-side over the current page), CSV export, and cell-click-to-
// copy. Designed for SQL results AND for the Browse Tab.
export function ResultGrid({
  result,
  loading,
  error,
  primaryKeys,
  sortBy,
  sortDir,
  onSort,
  rowActions,
  onCellEdit,
  editableColumns,
  selectable,
  selected,
  onToggleRow,
  onToggleAll,
  onColumnStats,
}: Props) {
  const [filter, setFilter] = React.useState("")
  const [inspect, setInspect] = React.useState<{ row: unknown[]; columns: { name: string; type: string }[] } | null>(null)
  // Inline cell edit. `editing` identifies the (row, col) currently in
  // edit mode; `editValue` mirrors the input. `saving` blocks double-
  // submit while the network request flies.
  const [editing, setEditing] = React.useState<{ row: number; col: number } | null>(null)
  const [editValue, setEditValue] = React.useState<string>("")
  const [saving, setSaving] = React.useState(false)

  const filtered = React.useMemo(() => {
    if (!result) return null
    const q = filter.trim().toLowerCase()
    if (!q) return result.rows
    return result.rows.filter((r) => r.some((v) => formatCell(v).toLowerCase().includes(q)))
  }, [result, filter])

  // Client-side sort is only used when onSort isn't provided.
  const sorted = React.useMemo(() => {
    if (!filtered) return null
    if (onSort || !sortBy) return filtered
    const idx = result?.columns.findIndex((c) => c.name === sortBy) ?? -1
    if (idx < 0) return filtered
    const arr = [...filtered]
    arr.sort((a, b) => compareCells(a[idx], b[idx]) * (sortDir === "DESC" ? -1 : 1))
    return arr
  }, [filtered, sortBy, sortDir, onSort, result])

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <div className="font-medium text-destructive mb-1">查询失败</div>
        <pre className="font-mono text-xs whitespace-pre-wrap break-all">{error}</pre>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        正在执行…
      </div>
    )
  }
  if (!result) {
    return (
      <div className="rounded-md border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
        还没有结果。在上方编辑器写 SQL，或点左侧表名浏览数据。
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="font-mono tabular-nums">
            {result.row_count} 行
            {result.truncated && <span className="ml-1 text-amber-600">· 已截断</span>}
          </Badge>
          <span>{(result.elapsed / 1_000_000).toFixed(1)} ms</span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤当前页"
            className="h-7 text-xs w-44"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => exportCSV(result)}
            title="导出 CSV"
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b">
            <tr>
              {selectable && (
                <th className="w-6 px-1.5 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="select all"
                    className="h-3 w-3 cursor-pointer"
                    checked={!!sorted && selected !== undefined && sorted.length > 0 && selected.size === sorted.length}
                    onChange={(e) => onToggleAll?.(e.target.checked)}
                  />
                </th>
              )}
              <th className="w-10 px-2 py-1.5 text-right text-muted-foreground font-normal">#</th>
              {result.columns.map((col, i) => {
                const isPK = primaryKeys?.has(col.name)
                const isSorted = sortBy === col.name
                return (
                  <th
                    key={i}
                    className={cn(
                      "px-2 py-1.5 text-left font-medium whitespace-nowrap",
                      isPK && "text-amber-700 dark:text-amber-300"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        const nextDir = isSorted && sortDir === "ASC" ? "DESC" : "ASC"
                        onSort?.(col.name, nextDir)
                      }}
                      className="inline-flex items-center gap-1 hover:text-primary transition-colors"
                    >
                      {isPK && <KeyRound className="w-3 h-3" />}
                      {col.name}
                      {isSorted &&
                        (sortDir === "ASC" ? (
                          <ArrowUp className="w-3 h-3" />
                        ) : (
                          <ArrowDown className="w-3 h-3" />
                        ))}
                    </button>
                    <span className="ml-1 text-[10px] text-muted-foreground font-mono normal-case">
                      {col.type}
                    </span>
                    {onColumnStats && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onColumnStats(col.name, e.currentTarget)
                        }}
                        className="ml-1 inline-flex opacity-40 hover:opacity-100 text-muted-foreground hover:text-primary transition-opacity"
                        title="列数据摘要：唯一值/NULL/最常见值"
                      >
                        <BarChart3 className="w-3 h-3" />
                      </button>
                    )}
                  </th>
                )
              })}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {sorted?.map((row, r) => (
              <tr
                key={r}
                className={cn(
                  "border-b last:border-b-0 hover:bg-muted/40 group",
                  selected?.has(r) && "bg-primary/5"
                )}
              >
                {selectable && (
                  <td className="px-1.5 py-1 align-top">
                    <input
                      type="checkbox"
                      aria-label={`select row ${r + 1}`}
                      className="h-3 w-3 cursor-pointer"
                      checked={selected?.has(r) ?? false}
                      onChange={() => onToggleRow?.(r)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                )}
                <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">{r + 1}</td>
                {row.map((cell, c) => {
                  const colName = result.columns[c]?.name ?? ""
                  const isEditable = !!onCellEdit && (editableColumns?.has(colName) ?? false)
                  const isEditing = !!editing && editing.row === r && editing.col === c
                  return (
                    <Cell
                      key={c}
                      value={cell}
                      editable={isEditable}
                      editing={isEditing}
                      editValue={editValue}
                      saving={isEditing && saving}
                      onStartEdit={() => {
                        setEditing({ row: r, col: c })
                        setEditValue(cell === null || cell === undefined ? "" : formatCell(cell))
                      }}
                      onCancelEdit={() => { setEditing(null); setSaving(false) }}
                      onChangeEdit={setEditValue}
                      onCommitEdit={async (asNull) => {
                        if (!onCellEdit) return
                        const orig = cell === null || cell === undefined ? "" : formatCell(cell)
                        const next = asNull ? null : editValue
                        // Skip the network call when value didn't change.
                        if ((next === null && cell === null) ||
                            (next !== null && next === orig)) {
                          setEditing(null)
                          return
                        }
                        setSaving(true)
                        try {
                          await onCellEdit(r, colName, next)
                          setEditing(null)
                        } catch (e) {
                          toast.error((e as Error)?.message ?? "保存失败")
                        } finally {
                          setSaving(false)
                        }
                      }}
                    />
                  )
                })}
                <td className="text-right opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pr-1">
                  {rowActions?.(r)}
                  <button
                    type="button"
                    onClick={() => setInspect({ row, columns: result.columns })}
                    className="p-1 hover:text-primary"
                    title="查看整行"
                  >
                    <Maximize2 className="w-3 h-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!inspect} onOpenChange={(v) => !v && setInspect(null)}>
        <DialogContent className="sm:max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>行详情</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto pr-2 space-y-2">
            {inspect?.columns.map((col, i) => {
              const raw = inspect.row[i]
              const text = formatCell(raw)
              const isJSON = looksLikeJSON(text)
              return (
                <div key={col.name} className="text-sm border-b pb-2 last:border-b-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium">{col.name}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{col.type}</span>
                    <button
                      type="button"
                      className="ml-auto text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                      onClick={() => copy(text)}
                    >
                      <Copy className="w-3 h-3" /> 复制
                    </button>
                  </div>
                  {raw === null ? (
                    <span className="text-muted-foreground italic">NULL</span>
                  ) : isJSON ? (
                    <pre className="bg-muted rounded p-2 text-xs whitespace-pre-wrap break-all font-mono max-h-60 overflow-y-auto">
                      {prettyJSON(text)}
                    </pre>
                  ) : (
                    <div className="font-mono text-xs whitespace-pre-wrap break-all">{text}</div>
                  )}
                </div>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Cell({
  value,
  editable,
  editing,
  editValue,
  saving,
  onStartEdit,
  onCancelEdit,
  onChangeEdit,
  onCommitEdit,
}: {
  value: unknown
  editable: boolean
  editing: boolean
  editValue: string
  saving: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onChangeEdit: (v: string) => void
  onCommitEdit: (asNull: boolean) => void
}) {
  const text = formatCell(value)
  const isNull = value === null
  // Phase 30 — humanised cell rendering.
  //   booleans  → ✓ green / ✗ muted
  //   null      → small muted "NULL" pill
  //   JSON      → blue file icon + truncated preview (existing)
  //   numbers   → right-aligned tabular nums for visual alignment in
  //               numeric columns (caller wraps a `tabular-nums` class)
  //   long text → truncate + native tooltip
  const isBool = typeof value === "boolean" ||
    (typeof value === "string" && (value === "true" || value === "false" || value === "TRUE" || value === "FALSE"))
  const boolValue = typeof value === "boolean"
    ? value
    : value === "true" || value === "TRUE"
  const isNumber = typeof value === "number" || typeof value === "bigint"

  if (editing) {
    return (
      <td className="px-1 py-0.5 align-top">
        <div className="flex items-center gap-1">
          <Input
            value={editValue}
            onChange={(e) => onChangeEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                onCommitEdit(false)
              } else if (e.key === "Escape") {
                e.preventDefault()
                onCancelEdit()
              }
            }}
            autoFocus
            disabled={saving}
            className="h-7 text-xs font-mono"
          />
          <button
            type="button"
            className="p-0.5 hover:text-emerald-600 disabled:opacity-40"
            onClick={() => onCommitEdit(false)}
            disabled={saving}
            title="保存（回车）"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          </button>
          <button
            type="button"
            className="p-0.5 hover:text-amber-600 disabled:opacity-40"
            onClick={() => onCommitEdit(true)}
            disabled={saving}
            title="设为 NULL"
          >
            <span className="text-[9px] font-mono">∅</span>
          </button>
          <button
            type="button"
            className="p-0.5 hover:text-destructive disabled:opacity-40"
            onClick={onCancelEdit}
            disabled={saving}
            title="取消（Esc）"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </td>
    )
  }

  return (
    <td
      className={cn(
        "px-2 py-1 max-w-xs truncate align-top",
        isNull && "text-muted-foreground italic",
        isNumber && "tabular-nums text-right",
        editable && "cursor-text",
      )}
      title={isNull ? "NULL" : editable ? `${text}\n\n双击以编辑` : text}
      onClick={() => copy(text)}
      onDoubleClick={(e) => {
        if (!editable) return
        e.preventDefault()
        e.stopPropagation()
        onStartEdit()
      }}
    >
      {isNull ? (
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 bg-muted/50 px-1 py-0.5 rounded font-mono">
          null
        </span>
      ) : isBool ? (
        <span className={cn(
          "inline-flex items-center gap-1 font-mono text-[10px] uppercase",
          boolValue ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400"
        )}>
          {boolValue ? "✓ true" : "✗ false"}
        </span>
      ) : looksLikeJSON(text) ? (
        <FileJsonInline text={text} />
      ) : (
        text
      )}
    </td>
  )
}

function FileJsonInline({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <FileJson className="w-3 h-3 text-blue-500" />
      <span className="truncate">{text}</span>
    </span>
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (typeof v === "bigint") return v.toString()
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function compareCells(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === "number" && typeof b === "number") return a - b
  return formatCell(a).localeCompare(formatCell(b))
}

function looksLikeJSON(s: string): boolean {
  if (s.length < 2) return false
  const c = s.trimStart()[0]
  return c === "{" || c === "["
}

function prettyJSON(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

function copy(text: string) {
  if (typeof navigator === "undefined") return
  navigator.clipboard?.writeText(text).then(() => toast.success("已复制", { duration: 1200 }))
}

function exportCSV(result: DBQueryResult) {
  const escape = (s: string) => `"${s.replace(/"/g, '""')}"`
  const head = result.columns.map((c) => escape(c.name)).join(",")
  const body = result.rows.map((r) => r.map((v) => escape(formatCell(v))).join(",")).join("\n")
  const blob = new Blob([head + "\n" + body], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `result-${Date.now()}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
