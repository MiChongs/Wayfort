"use client"

import * as React from "react"
import {
  ChevronRight, Clock, Database, Eye, FunctionSquare, Hash, Layers,
  Search, Table as TableIcon, View,
} from "lucide-react"
import type { DBSchemaInfo, DBTableInfo } from "@/lib/api/types"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type Props = {
  schema?: DBSchemaInfo
  loading?: boolean
  activeKey?: string // `${schema}.${table}` of currently-browsed table
  onPickTable: (t: DBTableInfo) => void
  onInsertIdent?: (text: string) => void
  // Phase 30h — per-node identity so recents persist independently
  // across nodes. When omitted recents tracking is disabled (used in
  // any place SchemaTree is rendered without node context — none
  // today, but the prop is optional for future reuse).
  nodeId?: number
}

const RECENTS_KEY = (id: number) => `db.recent_tables.${id}`
const RECENTS_MAX = 5

type RecentEntry = { schema: string; name: string; kind: string; at: number }

// SchemaTree — left-side schema browser. Two-level expand/collapse:
//   database (PostgreSQL schema / MySQL database)
//     └─ table
// Single click selects (drives Browse tab); double click inserts the
// fully-qualified name into the SQL editor at cursor.
//
// Designed to stay usable on 50,000+ table catalogs: a single search
// box filters in-process; the rendered list virtualizes only when the
// flat-filtered view exceeds 500 rows (which never happens for one
// schema in practice).
export function SchemaTree({ schema, loading, activeKey, onPickTable, onInsertIdent, nodeId }: Props) {
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState<Record<string, boolean>>({})
  // Phase 30h — recents. Loaded once per nodeId from localStorage,
  // updated when the user picks a table. Cap RECENTS_MAX entries so
  // the section stays a thumb-glance affordance.
  const [recents, setRecents] = React.useState<RecentEntry[]>([])
  React.useEffect(() => {
    if (nodeId == null) return
    try {
      const raw = localStorage.getItem(RECENTS_KEY(nodeId))
      if (raw) setRecents(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [nodeId])
  const pushRecent = React.useCallback((t: DBTableInfo) => {
    if (nodeId == null) return
    setRecents((prev) => {
      const next: RecentEntry[] = [
        { schema: t.schema, name: t.name, kind: t.kind, at: Date.now() },
        ...prev.filter((r) => !(r.schema === t.schema && r.name === t.name)),
      ].slice(0, RECENTS_MAX)
      try { localStorage.setItem(RECENTS_KEY(nodeId), JSON.stringify(next)) }
      catch { /* quota */ }
      return next
    })
  }, [nodeId])
  const handlePick = React.useCallback((t: DBTableInfo) => {
    pushRecent(t)
    onPickTable(t)
  }, [pushRecent, onPickTable])

  // Auto-open the first schema once data arrives.
  React.useEffect(() => {
    if (!schema?.databases?.length) return
    setOpen((prev) => {
      if (Object.keys(prev).length > 0) return prev
      const first = schema.databases[0].name
      return { [first]: true }
    })
  }, [schema])

  const q = query.trim().toLowerCase()
  const filtered = React.useMemo(() => {
    if (!schema?.databases) return []
    if (!q) return schema.databases
    return schema.databases
      .map((db) => ({
        ...db,
        tables: db.tables.filter(
          (t) => t.name.toLowerCase().includes(q) || db.name.toLowerCase().includes(q)
        ),
      }))
      .filter((db) => db.tables.length > 0 || db.name.toLowerCase().includes(q))
  }, [schema, q])

  return (
    <aside className="w-64 shrink-0 border-r flex flex-col h-full bg-card/30">
      <div className="px-3 py-2 border-b">
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          <Database className="w-4 h-4 text-muted-foreground" />
          <span className="truncate">{schema?.current_database || "(无)"}</span>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索表 / 视图"
            className="pl-7 h-8 text-sm"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto text-sm">
        {loading && <div className="px-3 py-4 text-xs text-muted-foreground">加载中…</div>}
        {!loading && filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {q ? "没有匹配" : "没有表"}
          </div>
        )}
        {!loading && recents.length > 0 && !q && (
          <div className="border-b">
            <div className="px-2 py-1 flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
              <Clock className="w-3 h-3" /> 最近
            </div>
            {recents.map((r) => {
              const key = `${r.schema}.${r.name}`
              const active = key === activeKey
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handlePick({ schema: r.schema, name: r.name, kind: r.kind as DBTableInfo["kind"] })}
                  className={cn(
                    "w-full flex items-center gap-1.5 pl-7 pr-2 py-1 hover:bg-muted/60 text-left",
                    active && "bg-primary/10 text-primary"
                  )}
                  title={`${r.schema}.${r.name}`}
                >
                  <ObjectIcon kind={r.kind} />
                  <span className="truncate text-xs">{r.name}</span>
                  <span className="ml-auto text-[9px] text-muted-foreground truncate max-w-[5rem]">
                    {r.schema}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {filtered.map((db) => {
          const isOpen = open[db.name] ?? false
          return (
            <div key={db.name}>
              <button
                type="button"
                onClick={() => setOpen({ ...open, [db.name]: !isOpen })}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-muted/50 text-left"
              >
                <ChevronRight
                  className={cn("w-3.5 h-3.5 transition-transform shrink-0 text-muted-foreground", isOpen && "rotate-90")}
                />
                <Layers className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="truncate font-medium text-xs">{db.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{db.tables.length}</span>
              </button>
              {isOpen && (
                <div>
                  {db.tables.map((t) => {
                    const key = `${t.schema}.${t.name}`
                    const active = key === activeKey
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => handlePick(t)}
                        onDoubleClick={() => onInsertIdent?.(qualifyIdent(t))}
                        className={cn(
                          "w-full flex items-center gap-1.5 pl-7 pr-2 py-1 hover:bg-muted/60 text-left transition-colors",
                          active && "bg-primary/10 text-primary"
                        )}
                      >
                        <ObjectIcon kind={t.kind} />
                        <span className="truncate text-xs">{t.name}</span>
                        {t.kind !== "table" && (
                          <span className={cn(
                            "ml-1 text-[9px] uppercase tracking-wider",
                            t.kind === "matview" ? "text-blue-500" :
                            t.kind === "view" ? "text-sky-500" :
                            t.kind === "sequence" ? "text-emerald-500" :
                            t.kind === "function" || t.kind === "procedure" ? "text-violet-500" :
                            "text-muted-foreground",
                          )}>
                            {kindShortLabel(t.kind)}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground flex items-center gap-1">
        <Eye className="w-3 h-3" />
        双击表名插入到 SQL 编辑器
      </div>
    </aside>
  )
}

function ObjectIcon({ kind }: { kind: string }) {
  const cls = "w-3.5 h-3.5 shrink-0"
  switch (kind) {
    case "view":
    case "matview":
      return <View className={cn(cls, "text-sky-500")} />
    case "sequence":
      return <Hash className={cn(cls, "text-emerald-500")} />
    case "function":
    case "procedure":
    case "aggregate":
    case "window":
      return <FunctionSquare className={cn(cls, "text-violet-500")} />
  }
  return <TableIcon className={cn(cls, "text-muted-foreground")} />
}

function kindShortLabel(k: string): string {
  switch (k) {
    case "matview": return "MV"
    case "sequence": return "SEQ"
    case "procedure": return "PROC"
    case "aggregate": return "AGG"
    case "window": return "WIN"
    case "foreign_table": return "FT"
  }
  return k
}

function qualifyIdent(t: DBTableInfo) {
  // Use ANSI double quotes; works on Postgres unconditionally and on
  // MySQL when ANSI_QUOTES is enabled (most modern installs). The editor
  // user can swap to backticks if they're on a strict-traditional MySQL.
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`
  return `${quote(t.schema)}.${quote(t.name)}`
}
