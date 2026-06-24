"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2, Search } from "lucide-react"
import { dbService } from "@/lib/api/services"
import type { ForeignKeyTarget } from "@/lib/api/types"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

interface Props {
  open: boolean
  onClose: () => void
  nodeId: number
  schema: string
  table: string
  column: string
  database?: string
  onPick: (value: unknown) => void
}

// ForeignKeyPicker — Phase 2C.1. A right-side Sheet that resolves the outbound
// FK target for (schema, table, column) and lists candidate values from the
// referenced table so the user can pick one to write back into the cell.
// Target resolution comes from the server (/db/fk-targets); the candidate list
// is a read-only SELECT that rides the same audited /db/query path as the data
// grid. Only identifiers resolved server-side ever reach the SQL — the free-text
// filter is single-quote-escaped, never identifier-substituted.
export function ForeignKeyPicker({ open, onClose, nodeId, schema, table, column, database, onPick }: Props) {
  const fkQuery = useQuery({
    queryKey: ["fk-target", nodeId, database ?? "", schema, table, column],
    queryFn: () => dbService.foreignKeyTargets(nodeId, { schema, table, column, database }),
    enabled: open,
    retry: false,
  })
  const fk: ForeignKeyTarget | undefined = fkQuery.data

  const [filter, setFilter] = useState("")
  useEffect(() => {
    if (!open) setFilter("")
  }, [open])

  const candidates = useQuery({
    queryKey: ["fk-candidates", nodeId, database ?? "", schema, table, column, filter],
    queryFn: async () => {
      const target = fk
      if (!target) throw new Error("no foreign key target")
      const refIdents = target.ref_columns.map(quoteIdent)
      const labelName = target.label_column || target.ref_columns[0] || ""
      const labelIdent = quoteIdent(labelName)
      const labelAlias = target.ref_columns.includes(labelName) ? labelName : "__label"
      const selectList = target.ref_columns.includes(labelName)
        ? refIdents.join(", ")
        : `${refIdents.join(", ")}, ${labelIdent} AS __label`
      const from = `${quoteIdent(target.ref_schema)}.${quoteIdent(target.ref_table)}`
      let sql = `SELECT ${selectList} FROM ${from}`
      const trimmed = filter.trim()
      if (trimmed) {
        const esc = trimmed.replace(/'/g, "''")
        sql += ` WHERE CAST(${labelIdent} AS CHAR) LIKE '%${esc}%'`
      }
      sql += ` ORDER BY 2 LIMIT 200`
      return dbService.query(nodeId, sql, { database, reason: "fk-picker" })
    },
    enabled: open && !!fk,
  })

  const refCol = fk?.ref_columns[0] ?? ""
  const resultCols = candidates.data?.columns ?? []
  const refIdx = resultCols.findIndex((c) => c.name === refCol)
  const labelIdx = resultCols.findIndex(
    (c) => c.name === (fk?.ref_columns.includes(fk.label_column) ? fk.label_column : "__label"),
  )

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[560px] sm:max-w-[560px] flex flex-col gap-3">
        <SheetHeader>
          <SheetTitle>外键取值</SheetTitle>
          <SheetDescription>
            {fk ? (
              <>
                当前列 <code className="font-mono">{column}</code> 引用 →{" "}
                <code className="font-mono">
                  {fk.ref_schema}.{fk.ref_table}({fk.ref_columns.join(", ")})
                </code>
              </>
            ) : (
              <>
                解析列 <code className="font-mono">{schema}.{table}.{column}</code> 的外键目标…
              </>
            )}
          </SheetDescription>
        </SheetHeader>

        {fkQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> 解析外键目标…
          </div>
        ) : fkQuery.isError ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            该列没有可解析的外键目标（后端未在 {schema}.{table} 上找到引用 {column} 的外键约束）。
            <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
              {fkQuery.error instanceof Error ? fkQuery.error.message : ""}
            </pre>
          </div>
        ) : fk ? (
          <>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`搜索 ${fk.label_column || refCol}…`}
                className="h-8 text-sm pl-7"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-md border">
              {candidates.isLoading ? (
                <div className="p-6 text-sm text-muted-foreground text-center">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> 加载候选值…
                </div>
              ) : candidates.data && candidates.data.rows.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground text-center">引用表中没有数据。</div>
              ) : (
                <ul className="divide-y">
                  {candidates.data?.rows.map((row, i) => {
                    const val = refIdx >= 0 ? row[refIdx] : row[0]
                    const label = labelIdx >= 0 ? row[labelIdx] : row[row.length - 1]
                    return (
                      <li
                        key={i}
                        className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-muted/50"
                      >
                        <span className="min-w-0 truncate text-sm">
                          <code className="text-xs text-muted-foreground">{String(val)}</code>
                          <span className="ml-2">{String(label ?? "")}</span>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => {
                            onPick(val)
                            onClose()
                          }}
                        >
                          选择
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              只读取前 200 行；用上方搜索框缩小范围。选择后将写回当前单元格。
            </p>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

// quoteIdent — emit a trusted identifier bare when it is a plain safe name
// (matches every dialect without quoting); otherwise ANSI double-quote with
// embedded-quote escaping. Inputs are server-resolved FK metadata, never raw
// user keystrokes.
function quoteIdent(s: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}
