"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Activity, Code2, Database, FileCode, ListOrdered, RefreshCw, Telescope, Terminal, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dbService, nodeService } from "@/lib/api/services"
import type { DBQueryResult, DBTableInfo } from "@/lib/api/types"
import { SchemaTree } from "@/components/db/schema-tree"
import { ResultGrid } from "@/components/db/result-grid"
import { SQLEditor } from "@/components/db/sql-editor"
import { BrowseTab } from "@/components/db/browse-tab"
import { ProcessesPanel } from "@/components/db/processes-panel"
import { KeyboardShortcuts } from "@/components/db/keyboard-shortcuts"
import { StatusBar } from "@/components/db/status-bar"
import { cn } from "@/lib/utils"

type Props = {
  nodeId: number
  embedded?: boolean
  className?: string
}

// Result set inside the SQL tab. Each Run / Explain produces one entry;
// the user keeps them around until explicit close. localStorage history
// covers reload-survival; in-memory tabs are the immediate workspace.
type ResultTab = {
  id: number
  title: string
  sql: string
  startedAt: number
  // Exactly one of result / error / pending is populated.
  result?: DBQueryResult
  error?: string
  pending?: boolean
  // Tag the source so the title bar can show 📋 / EXPLAIN / EXPLAIN ANALYZE.
  kind: "query" | "explain" | "explain_analyze"
}

let resultIdSeq = 0

export function DBStudio({ nodeId, embedded, className }: Props) {
  const node = useQuery({ queryKey: ["node", nodeId], queryFn: () => nodeService.get(nodeId) })

  const [database, setDatabase] = React.useState<string | undefined>(undefined)
  const dbList = useQuery({
    queryKey: ["db.databases", nodeId],
    queryFn: () => dbService.databases(nodeId),
    retry: false,
  })
  React.useEffect(() => {
    if (database !== undefined) return
    const list = dbList.data?.databases
    if (!list || list.length === 0) return
    const preferred = list.find((d) => d !== "postgres") ?? list[0]
    setDatabase(preferred)
  }, [dbList.data, database])

  const schema = useQuery({
    queryKey: ["db.schema", nodeId, database],
    queryFn: () => dbService.schema(nodeId, database),
    retry: false,
    enabled: database !== undefined,
  })

  // Phase 22 — pull the per-node capability matrix once. Cached for 5
  // minutes; toolbar / sidebar / tab triggers all gate on it so an
  // OLAP engine like StarRocks (no row edits, no FKs) doesn't expose
  // buttons that would 4xx server-side.
  const caps = useQuery({
    queryKey: ["db.capabilities", nodeId],
    queryFn: () => dbService.capabilities(nodeId),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const c = caps.data

  const [tab, setTab] = React.useState<"browse" | "query" | "processes">("browse")
  const [selected, setSelected] = React.useState<DBTableInfo | undefined>()
  const [sql, setSql] = React.useState(
    "-- Ctrl+Enter 执行；左侧表名双击插入到此处\nSELECT 1;\n"
  )

  // Multi-result tabs ----------------------------------------------------------
  const [results, setResults] = React.useState<ResultTab[]>([])
  const [activeResult, setActiveResult] = React.useState<number | null>(null)

  React.useEffect(() => {
    setSelected(undefined)
  }, [database])

  const upsertResult = React.useCallback((tab: ResultTab) => {
    setResults((prev) => {
      const idx = prev.findIndex((r) => r.id === tab.id)
      if (idx < 0) return [...prev, tab]
      const next = prev.slice()
      next[idx] = tab
      return next
    })
  }, [])

  const runStatement = React.useCallback(
    (sqlText: string, kind: ResultTab["kind"]) => {
      const id = ++resultIdSeq
      const title = summariseSQL(sqlText)
      const baseTab: ResultTab = { id, title, sql: sqlText, startedAt: Date.now(), pending: true, kind }
      upsertResult(baseTab)
      setActiveResult(id)
      const promise =
        kind === "query"
          ? dbService.query(nodeId, sqlText, { database })
          : dbService.explain(nodeId, sqlText, { database, analyze: kind === "explain_analyze" })
      promise
        .then((r) => {
          upsertResult({ ...baseTab, pending: false, result: r })
          if (r.truncated) toast.info(`结果被截断在 ${r.row_count} 行`)
        })
        .catch((e: { message?: string }) => {
          upsertResult({ ...baseTab, pending: false, error: e.message || "未知错误" })
        })
    },
    [database, nodeId, upsertResult],
  )

  // Phase 30 — multi-statement script runner. The server splits on
  // top-level ; (quote / dollar-quote aware) and runs each statement,
  // returning per-stmt results. We expand the response into one
  // ResultTab per statement so the UI mirrors what a SQL CLI would
  // show: success row counts for DDL, full result grids for SELECTs,
  // red error tabs at the first failure.
  const runScript = React.useCallback(
    async (script: string) => {
      const trimmed = script.trim()
      if (!trimmed) return
      try {
        const resp = await dbService.queryMulti(nodeId, trimmed, { database })
        let firstId: number | null = null
        for (const r of resp.results) {
          const id = ++resultIdSeq
          if (firstId === null) firstId = id
          const baseTitle = `[${r.index + 1}] ${summariseSQL(r.statement)}`
          if (r.kind === "query" && r.result) {
            upsertResult({
              id, title: baseTitle, sql: r.statement,
              startedAt: Date.now(), pending: false, result: r.result, kind: "query",
            })
          } else if (r.kind === "exec" && r.exec) {
            // Render exec result as a synthetic 1-row "affected" table.
            upsertResult({
              id, title: baseTitle, sql: r.statement,
              startedAt: Date.now(), pending: false, kind: "query",
              result: {
                columns: [{ name: "affected", type: "BIGINT" }],
                rows: [[r.exec.affected]],
                truncated: false, elapsed: r.elapsed, row_count: 1,
              },
            })
          } else {
            upsertResult({
              id, title: baseTitle, sql: r.statement,
              startedAt: Date.now(), pending: false, error: r.error || "未知错误", kind: "query",
            })
          }
        }
        if (firstId !== null) setActiveResult(firstId)
        toast.success(`脚本已执行 ${resp.count} 条语句`)
      } catch (e) {
        toast.error((e as Error).message ?? "脚本执行失败")
      }
    },
    [database, nodeId, upsertResult],
  )

  const closeResult = (id: number) => {
    setResults((prev) => {
      const next = prev.filter((r) => r.id !== id)
      if (activeResult === id) {
        const last = next[next.length - 1]
        setActiveResult(last ? last.id : null)
      }
      return next
    })
  }

  const handlePickTable = (t: DBTableInfo) => {
    setSelected(t)
    setTab("browse")
  }

  const handleInsertIdent = (text: string) => {
    setSql((prev) => (prev.endsWith("\n") || prev === "" ? prev + text : prev + " " + text))
    setTab("query")
  }

  const errMsg = (schema.error as { message?: string })?.message
  const dbListErr = (dbList.error as { message?: string })?.message
  const databases = dbList.data?.databases ?? []
  const activeTab = results.find((r) => r.id === activeResult)
  const runPending = results.some((r) => r.pending)

  const dbPicker = (
    <div className="flex items-center gap-1.5">
      <Database className="w-3.5 h-3.5 text-muted-foreground" />
      <Select
        value={database ?? ""}
        onValueChange={(v) => setDatabase(v)}
        disabled={dbList.isLoading || databases.length === 0}
      >
        <SelectTrigger className="h-7 w-44 text-xs">
          <SelectValue placeholder={dbList.isLoading ? "加载中…" : "选择数据库"} />
        </SelectTrigger>
        <SelectContent>
          {databases.map((name) => (
            <SelectItem key={name} value={name} className="font-mono text-xs">
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <div className={cn("flex flex-col", embedded ? "h-full" : "h-[calc(100vh-56px)]", className)}>
      {!embedded && (
        <div className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Database className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium truncate">{node.data?.name ?? `节点 #${nodeId}`}</span>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {node.data?.protocol}
            </Badge>
            <span className="text-xs text-muted-foreground truncate">
              {node.data?.host}:{node.data?.port}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {dbPicker}
            <Link
              href={`/nodes/${nodeId}/dbcli`}
              className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
            >
              <Terminal className="w-3 h-3" /> 终端 CLI
            </Link>
            <KeyboardShortcuts />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => { dbList.refetch(); schema.refetch() }}
              title="刷新数据库与 schema"
            >
              <RefreshCw className={schema.isFetching || dbList.isFetching ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"} />
            </Button>
          </div>
        </div>
      )}

      {dbListErr && (
        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          无法获取数据库列表：<span className="font-mono">{dbListErr}</span>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <SchemaTree
          schema={schema.data}
          loading={schema.isLoading}
          activeKey={selected ? `${selected.schema}.${selected.name}` : undefined}
          onPickTable={handlePickTable}
          onInsertIdent={handleInsertIdent}
        />

        <div className="flex-1 min-w-0 flex flex-col">
          {errMsg ? (
            <div className="m-4 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
              <div className="font-medium text-destructive mb-1 flex items-center gap-1">
                <FileCode className="w-4 h-4" /> 连接失败
              </div>
              <pre className="font-mono text-xs whitespace-pre-wrap break-all">{errMsg}</pre>
              <p className="mt-2 text-xs text-muted-foreground">
                确认节点状态、凭据与代理链可达；只支持 MySQL 与 PostgreSQL。Redis / Mongo 请用终端 CLI。
              </p>
            </div>
          ) : (
            <Tabs value={tab} onValueChange={(v) => setTab(v as "browse" | "query" | "processes")} className="flex-1 min-h-0 flex flex-col">
              <div className="border-b px-3 pt-2 shrink-0 flex items-center justify-between gap-2">
                <TabsList>
                  <TabsTrigger value="browse" className="gap-1">
                    <Database className="w-3.5 h-3.5" /> 浏览
                  </TabsTrigger>
                  <TabsTrigger value="query" className="gap-1">
                    <Code2 className="w-3.5 h-3.5" /> SQL
                  </TabsTrigger>
                  {/* Phase 22 — gate Processes tab on adapter Capabilities.
                      Engines without observable process state (some
                      analytical engines, embedded SQL servers) skip the
                      tab entirely instead of showing an inert button. */}
                  {(c?.processes ?? true) && (
                    <TabsTrigger value="processes" className="gap-1">
                      <Activity className="w-3.5 h-3.5" /> 进程
                    </TabsTrigger>
                  )}
                </TabsList>
                {c?.vendor_label && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {c.vendor_label}
                  </Badge>
                )}
                {embedded && (
                  <div className="flex items-center gap-1 mb-1">
                    {dbPicker}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => { dbList.refetch(); schema.refetch() }}
                      title="刷新数据库与 schema"
                    >
                      <RefreshCw className={schema.isFetching || dbList.isFetching ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"} />
                    </Button>
                  </div>
                )}
              </div>
              <TabsContent value="browse" className="flex-1 min-h-0 m-0 flex">
                {selected ? (
                  <BrowseTab nodeId={nodeId} table={selected} database={database} caps={c} />
                ) : (
                  <div className="flex-1 grid place-items-center text-sm text-muted-foreground">
                    点左侧的表名开始浏览
                  </div>
                )}
              </TabsContent>
              <TabsContent value="processes" className="flex-1 min-h-0 m-0">
                <ProcessesPanel nodeId={nodeId} database={database} canKill={c?.kill_process ?? true} />
              </TabsContent>
              <TabsContent value="query" className="flex-1 min-h-0 m-0 flex flex-col">
                <div className="flex-1 min-h-0 flex flex-col gap-2 p-3">
                  <div className="h-[40%] min-h-[200px] flex flex-col gap-1">
                    <SQLEditor
                      nodeId={nodeId}
                      value={sql}
                      onChange={setSql}
                      onRun={(s) => runStatement(s, "query")}
                      busy={runPending}
                      extraActions={
                        <>
                          {/* Phase 30 — Multi-statement script runner. The
                              backend splits on top-level ; (quote-aware)
                              and runs each, producing one tab per stmt. */}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 gap-1 text-xs"
                            disabled={runPending || !sql.trim()}
                            onClick={() => runScript(sql)}
                            title="按分号拆分逐条执行；每条结果占一个 tab"
                          >
                            <ListOrdered className="w-3.5 h-3.5" /> 执行脚本
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 gap-1 text-xs"
                                disabled={runPending || !sql.trim()}
                              >
                                <Telescope className="w-3.5 h-3.5" /> EXPLAIN
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => runStatement(sql.trim(), "explain")}>
                                EXPLAIN
                              </DropdownMenuItem>
                              {(c?.explain_analyze ?? true) && (
                                <DropdownMenuItem onClick={() => runStatement(sql.trim(), "explain_analyze")}>
                                  EXPLAIN ANALYZE
                                  <span className="ml-2 text-[10px] text-muted-foreground">真的执行</span>
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </>
                      }
                    />
                  </div>
                  <div className="flex-1 min-h-0 border rounded-md overflow-hidden flex flex-col">
                    <ResultTabBar
                      results={results}
                      activeId={activeResult}
                      onActivate={setActiveResult}
                      onClose={closeResult}
                    />
                    <div className="flex-1 min-h-0">
                      <ResultGrid
                        result={activeTab?.result}
                        loading={activeTab?.pending}
                        error={activeTab?.error}
                      />
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
      {/* Phase 30b — live database status footer (size / objects /
          connections / version / uptime). 30s poll. */}
      <StatusBar nodeId={nodeId} database={database} />
    </div>
  )
}

function ResultTabBar({
  results,
  activeId,
  onActivate,
  onClose,
}: {
  results: ResultTab[]
  activeId: number | null
  onActivate: (id: number) => void
  onClose: (id: number) => void
}) {
  if (results.length === 0) {
    return (
      <div className="px-3 py-1 border-b text-[10px] text-muted-foreground bg-muted/30">
        还没有结果 — 在编辑器里写 SQL，Ctrl+Enter 执行
      </div>
    )
  }
  return (
    <div className="flex border-b bg-muted/30 overflow-x-auto">
      {results.map((r) => (
        <div
          key={r.id}
          className={cn(
            "group flex items-center gap-1.5 pl-3 pr-1.5 py-1 border-r min-w-0 cursor-pointer text-xs",
            r.id === activeId ? "bg-background text-foreground" : "text-muted-foreground hover:bg-muted/60",
          )}
          onClick={() => onActivate(r.id)}
        >
          <KindBadge kind={r.kind} />
          <span className="truncate max-w-[12rem]">{r.title}</span>
          {r.pending && <span className="text-[10px] text-amber-600">…</span>}
          {r.error && <span className="text-[10px] text-destructive">✕</span>}
          {r.result && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {r.result.row_count}行 · {(r.result.elapsed / 1_000_000).toFixed(0)}ms
            </span>
          )}
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 hover:text-destructive p-0.5"
            onClick={(e) => { e.stopPropagation(); onClose(r.id) }}
            title="关闭"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

function KindBadge({ kind }: { kind: ResultTab["kind"] }) {
  switch (kind) {
    case "explain":
      return <Badge variant="outline" className="text-[9px] px-1 py-0">EXP</Badge>
    case "explain_analyze":
      return <Badge variant="destructive" className="text-[9px] px-1 py-0">ANL</Badge>
    default:
      return <Badge variant="secondary" className="text-[9px] px-1 py-0">SQL</Badge>
  }
}

// summariseSQL truncates the SQL to a tab title. We strip leading
// comments + take the first meaningful line up to a sensible width.
function summariseSQL(s: string): string {
  const stripped = s
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
  const firstLine = stripped.split(/\r?\n/)[0] ?? stripped
  if (firstLine.length <= 50) return firstLine || "(空查询)"
  return firstLine.slice(0, 47) + "…"
}
