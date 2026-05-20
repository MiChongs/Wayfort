"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Code2, Database, FileCode, RefreshCw, Terminal } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { dbService, nodeService } from "@/lib/api/services"
import type { DBQueryResult, DBTableInfo } from "@/lib/api/types"
import { SchemaTree } from "@/components/db/schema-tree"
import { ResultGrid } from "@/components/db/result-grid"
import { SQLEditor } from "@/components/db/sql-editor"
import { BrowseTab } from "@/components/db/browse-tab"
import { cn } from "@/lib/utils"

type Props = {
  nodeId: number
  // embedded=true means the host (workspace tab) owns the outer chrome.
  embedded?: boolean
  className?: string
}

// DBStudio — visual DB browser.
//
// PostgreSQL caveat: each connection is bound to one database at
// connect time. The database picker here drives a per-DB pool on the
// backend (see internal/dbquery poolKey). Switching the picker reloads
// the schema tree from the new DB's catalog.
//
// MySQL: information_schema is cluster-wide, so the picker is more of a
// "default schema for unqualified queries" hint than a hard scope. We
// still keep it for symmetry + USE-equivalent behavior.
export function DBStudio({ nodeId, embedded, className }: Props) {
  const node = useQuery({ queryKey: ["node", nodeId], queryFn: () => nodeService.get(nodeId) })

  // database picker state: undefined while we load the list; "" once
  // the user explicitly picks "default" (driver-default for the node).
  // After the list loads we auto-pick the first non-system DB so the
  // user immediately sees their tables instead of an empty postgres DB.
  const [database, setDatabase] = React.useState<string | undefined>(undefined)
  const dbList = useQuery({
    queryKey: ["db.databases", nodeId],
    queryFn: () => dbService.databases(nodeId),
    retry: false,
  })

  // First-load auto-pick: prefer the node's proto_options.database if it's
  // in the list, else fall back to the first non-postgres / non-template
  // entry.
  React.useEffect(() => {
    if (database !== undefined) return
    const list = dbList.data?.databases
    if (!list || list.length === 0) return
    // Heuristic: skip "postgres" (the system bootstrap DB that's usually
    // empty) when the operator has other catalogs.
    const preferred = list.find((d) => d !== "postgres") ?? list[0]
    setDatabase(preferred)
  }, [dbList.data, database])

  const schema = useQuery({
    queryKey: ["db.schema", nodeId, database],
    queryFn: () => dbService.schema(nodeId, database),
    retry: false,
    enabled: database !== undefined,
  })

  const [tab, setTab] = React.useState<"browse" | "query">("browse")
  const [selected, setSelected] = React.useState<DBTableInfo | undefined>()
  const [sql, setSql] = React.useState(
    "-- Ctrl+Enter 执行；左侧表名双击插入到此处\nSELECT 1;\n"
  )
  const [result, setResult] = React.useState<DBQueryResult | undefined>()
  const [resultErr, setResultErr] = React.useState<string | undefined>()

  // Reset selected table when switching databases — the table list
  // becomes stale and stale Browse queries would hit the new pool with
  // an identifier from the old catalog.
  React.useEffect(() => {
    setSelected(undefined)
  }, [database])

  const run = useMutation({
    mutationFn: (s: string) => dbService.query(nodeId, s, { database }),
    onSuccess: (r) => {
      setResult(r)
      setResultErr(undefined)
      if (r.truncated) toast.info(`结果被截断在 ${r.row_count} 行`)
    },
    onError: (e: { message?: string }) => {
      setResult(undefined)
      setResultErr(e.message || "未知错误")
    },
  })

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
            <Tabs value={tab} onValueChange={(v) => setTab(v as "browse" | "query")} className="flex-1 min-h-0 flex flex-col">
              <div className="border-b px-3 pt-2 shrink-0 flex items-center justify-between gap-2">
                <TabsList>
                  <TabsTrigger value="browse" className="gap-1">
                    <Database className="w-3.5 h-3.5" /> 浏览
                  </TabsTrigger>
                  <TabsTrigger value="query" className="gap-1">
                    <Code2 className="w-3.5 h-3.5" /> SQL
                  </TabsTrigger>
                </TabsList>
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
                  <BrowseTab nodeId={nodeId} table={selected} database={database} />
                ) : (
                  <div className="flex-1 grid place-items-center text-sm text-muted-foreground">
                    点左侧的表名开始浏览
                  </div>
                )}
              </TabsContent>
              <TabsContent value="query" className="flex-1 min-h-0 m-0 flex flex-col">
                <div className="flex-1 min-h-0 flex flex-col gap-2 p-3">
                  <div className="h-[40%] min-h-[200px]">
                    <SQLEditor
                      nodeId={nodeId}
                      value={sql}
                      onChange={setSql}
                      onRun={(s) => run.mutate(s)}
                      busy={run.isPending}
                    />
                  </div>
                  <div className="flex-1 min-h-0 border rounded-md overflow-hidden">
                    <ResultGrid
                      result={result}
                      loading={run.isPending}
                      error={resultErr}
                    />
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  )
}
