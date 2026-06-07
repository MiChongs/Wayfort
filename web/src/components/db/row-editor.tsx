"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Database, KeyRound, Loader2, Save, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { dbService } from "@/lib/api/services"
import type { DBColumnInfo, DBTableInfo } from "@/lib/api/types"
import { cn } from "@/lib/utils"

type Mode = "edit" | "insert"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodeId: number
  database?: string
  table: DBTableInfo
  columns: DBColumnInfo[]
  mode: Mode
  // For edit mode: the row as it was loaded (column-name → raw value).
  initial?: Record<string, unknown>
  onSaved?: () => void
}

// RowEditor — modal form to update or insert a single row. The column
// list comes from the StructureTab cache (LoadColumns), so types +
// nullable + PK flags are known up-front. PK columns are read-only in
// edit mode (changing a PK is an UPDATE … SET pk = newpk WHERE pk =
// oldpk which the row CRUD API doesn't support; admins do that via
// raw SQL with their explicit reason).
//
// NULL handling: each field has a "NULL" toggle. Numeric / boolean
// fields get type-aware inputs; everything else is a Textarea so JSON,
// long text, and TEXT columns all work.
export function RowEditor({
  open,
  onOpenChange,
  nodeId,
  database,
  table,
  columns,
  mode,
  initial,
  onSaved,
}: Props) {
  const qc = useQueryClient()
  const editableCols = mode === "edit"
    ? columns.filter((c) => !c.is_primary_key) // PKs identify the row; don't allow editing
    : columns

  const [values, setValues] = React.useState<Record<string, string>>({})
  const [nulls, setNulls] = React.useState<Record<string, boolean>>({})

  // Hydrate from `initial` when the dialog opens.
  React.useEffect(() => {
    if (!open) return
    const v: Record<string, string> = {}
    const n: Record<string, boolean> = {}
    for (const c of columns) {
      const raw = initial?.[c.name]
      if (raw === null || raw === undefined) {
        n[c.name] = true
        v[c.name] = ""
      } else {
        n[c.name] = false
        v[c.name] = typeof raw === "string" ? raw : JSON.stringify(raw)
      }
    }
    setValues(v)
    setNulls(n)
  }, [open, columns, initial])

  const pkCols = columns.filter((c) => c.is_primary_key)
  const canEdit = mode === "insert" || pkCols.length > 0
  const pkKey = React.useMemo(() => {
    if (mode !== "edit" || !initial) return null
    return {
      columns: pkCols.map((c) => c.name),
      values: pkCols.map((c) => initial[c.name]),
    }
  }, [mode, initial, pkCols])

  const save = useMutation({
    mutationFn: async () => {
      // Build column lists, coercing values to typed primitives where
      // possible. Numeric columns parse the string; bool toggles back
      // to true/false; everything else stays a string and the driver
      // sorts the wire types per dialect.
      const setColumns: string[] = []
      const setValues: unknown[] = []
      for (const c of editableCols) {
        if (nulls[c.name]) {
          setColumns.push(c.name)
          setValues.push(null)
          continue
        }
        const raw = values[c.name]
        if (raw === undefined) continue
        // Skip empty string inputs in insert mode when the column has a
        // default — let the server apply the default. In edit mode we
        // forward "" verbatim so empty-string-vs-NULL stays explicit.
        if (mode === "insert" && raw === "" && c.default_value !== undefined) {
          continue
        }
        setColumns.push(c.name)
        setValues.push(coerce(raw, c.type))
      }
      if (mode === "insert") {
        return dbService.rowInsert(nodeId, table.schema, table.name, setColumns, setValues, { database })
      }
      if (!pkKey) throw new Error("没有主键列，无法定位行")
      return dbService.rowUpdate(
        nodeId, table.schema, table.name,
        pkKey, setColumns, setValues,
        { database },
      )
    },
    onSuccess: (r) => {
      toast.success(`${mode === "insert" ? "已新增" : "已更新"}：影响 ${r.affected} 行 (${(r.elapsed / 1_000_000).toFixed(1)} ms)`)
      // Invalidate so the grid re-fetches the new state.
      qc.invalidateQueries({ queryKey: ["db.rows", nodeId, database, table.schema, table.name] })
      onSaved?.()
      onOpenChange(false)
    },
    onError: (e: { message?: string }) => toast.error(e.message || "保存失败"),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="w-4 h-4" />
            {mode === "insert" ? "新增行" : "编辑行"}
            <Badge variant="outline" className="font-mono text-[10px]">
              {table.schema}.{table.name}
            </Badge>
          </DialogTitle>
          {!canEdit && (
            <DialogDescription className="text-destructive">
              表没有主键，无法可靠定位单行。请在 SQL Tab 用完整 WHERE 子句操作。
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto pr-2 space-y-3">
          {mode === "edit" && pkCols.length > 0 && (
            <section className="rounded-md border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                <KeyRound className="w-3 h-3 text-amber-600" /> 主键 (只读)
              </div>
              <div className="grid grid-cols-2 gap-2">
                {pkCols.map((c) => (
                  <div key={c.name}>
                    <Label className="text-[11px] text-muted-foreground">{c.name}</Label>
                    <Input value={String(initial?.[c.name] ?? "")} readOnly className="h-8 text-xs font-mono" />
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="space-y-3">
            {editableCols.map((c) => (
              <FieldRow
                key={c.name}
                column={c}
                value={values[c.name] ?? ""}
                isNull={nulls[c.name] ?? false}
                onChange={(v) => setValues((s) => ({ ...s, [c.name]: v }))}
                onNullToggle={(v) => setNulls((s) => ({ ...s, [c.name]: v }))}
              />
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!canEdit || save.isPending}
          >
            {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {mode === "insert" ? "新增" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FieldRow({
  column,
  value,
  isNull,
  onChange,
  onNullToggle,
}: {
  column: DBColumnInfo
  value: string
  isNull: boolean
  onChange: (v: string) => void
  onNullToggle: (v: boolean) => void
}) {
  const big = isBigText(column.type)
  const numeric = isNumeric(column.type)
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 items-start">
      <div className="pt-1.5">
        <Label className="text-xs font-medium block truncate" title={column.name}>
          {column.name}
        </Label>
        <div className="text-[10px] text-muted-foreground font-mono truncate">{column.type}</div>
        <div className="text-[10px] mt-1 flex items-center gap-1">
          <Switch
            checked={!isNull}
            onCheckedChange={(v) => onNullToggle(!v)}
            disabled={!column.nullable && !isNull}
            className="h-3.5 w-7"
          />
          <span className={cn("text-[10px]", isNull && "text-muted-foreground italic")}>
            {isNull ? "NULL" : "值"}
          </span>
        </div>
      </div>
      <div>
        {big ? (
          <Textarea
            value={isNull ? "" : value}
            onChange={(e) => onChange(e.target.value)}
            disabled={isNull}
            rows={3}
            className="font-mono text-xs"
          />
        ) : (
          <Input
            value={isNull ? "" : value}
            onChange={(e) => onChange(e.target.value)}
            disabled={isNull}
            type={numeric ? "text" : "text"}
            inputMode={numeric ? "decimal" : undefined}
            className="h-8 text-xs font-mono"
          />
        )}
        {column.default_value && !isNull && value === "" && (
          <div className="text-[10px] text-muted-foreground mt-0.5">
            空 = 用默认值 <code className="bg-muted px-1">{column.default_value}</code>
          </div>
        )}
      </div>
    </div>
  )
}

// coerce: best-effort string → JSON primitive. The driver handles bool /
// number literals correctly when passed as bare types; we keep strings
// for text-shaped columns so the DSN's parseTime / charset settings stay
// authoritative.
//
// Re-exported as `coerceCell` for ResultGrid's inline-edit path so all
// row-mutating UI shares the same coercion table.
export const coerceCell = (raw: string, dbType: string) => coerce(raw, dbType)
function coerce(raw: string, dbType: string): unknown {
  if (raw === "") {
    return ""
  }
  const t = dbType.toUpperCase()
  if (t.includes("BOOL")) {
    if (raw === "true" || raw === "t" || raw === "1") return true
    if (raw === "false" || raw === "f" || raw === "0") return false
    return raw
  }
  if (isNumeric(t)) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
    return raw
  }
  return raw
}

function isNumeric(t: string): boolean {
  const u = t.toUpperCase()
  return /\b(INT|SERIAL|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|NUMBER|BIGINT|SMALLINT|TINYINT)\b/.test(u)
}

function isBigText(t: string): boolean {
  const u = t.toUpperCase()
  return /\b(TEXT|JSON|JSONB|CLOB|XML|BLOB|BYTEA)\b/.test(u) || u.includes("(")
}

// Convenience helper exported so BrowseTab can call delete without
// constructing the dialog (delete is one-click + confirm).
export async function deleteRow(
  nodeId: number,
  database: string | undefined,
  table: DBTableInfo,
  columns: DBColumnInfo[],
  row: Record<string, unknown>,
): Promise<{ affected: number }> {
  const pkCols = columns.filter((c) => c.is_primary_key)
  if (pkCols.length === 0) throw new Error("表没有主键，无法可靠定位单行")
  return dbService.rowDelete(
    nodeId, table.schema, table.name,
    {
      columns: pkCols.map((c) => c.name),
      values: pkCols.map((c) => row[c.name]),
    },
    { database },
  )
}
