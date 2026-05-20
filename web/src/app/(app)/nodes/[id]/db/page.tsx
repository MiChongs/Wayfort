"use client"

import * as React from "react"
import Link from "next/link"
import { use } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { ArrowLeft, Code2, Database, FileCode, RefreshCw, Terminal } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { dbService, nodeService } from "@/lib/api/services"
import type { DBQueryResult, DBTableInfo } from "@/lib/api/types"
import { SchemaTree } from "@/components/db/schema-tree"
import { ResultGrid } from "@/components/db/result-grid"
import { SQLEditor } from "@/components/db/sql-editor"
import { BrowseTab } from "@/components/db/browse-tab"

// Page entry: 节点详情下的 DB Studio。
//
// 左：schema tree（点表 → Browse Tab 自动加载）
// 右上：Tab 切换 "Browse"（浏览选中表） / "Query"（写 SQL）
// 右下：结果区
//
// 这是面向 DBA / 运维工程师的"数据探索"界面，而不是 IDE。一切操作可
// 用一次点击完成；SQL 是给需要灵活查询的人的逃生出口。
export default function DBStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)

  const node = useQuery({ queryKey: ["node", nodeId], queryFn: () => nodeService.get(nodeId) })
  const schema = useQuery({
    queryKey: ["db.schema", nodeId],
    queryFn: () => dbService.schema(nodeId),
    retry: false,
  })

  const [tab, setTab] = React.useState<"browse" | "query">("browse")
  const [selected, setSelected] = React.useState<DBTableInfo | undefined>()
  const [sql, setSql] = React.useState(
    "-- Ctrl+Enter 执行；左侧表名双击插入到此处\nSELECT 1;\n"
  )
  const [result, setResult] = React.useState<DBQueryResult | undefined>()
  const [resultErr, setResultErr] = React.useState<string | undefined>()

  const run = useMutation({
    mutationFn: (s: string) => dbService.query(nodeId, s),
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

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
        <Link
          href={`/workspace?node=${nodeId}`}
          className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-3 h-3" /> 工作台
        </Link>
        <div className="h-4 w-px bg-border" />
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
            onClick={() => schema.refetch()}
            title="刷新 schema"
          >
            <RefreshCw className={schema.isFetching ? "w-3.5 h-3.5 animate-spin" : "w-3.5 h-3.5"} />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <SchemaTree
          schema={schema.data}
          loading={schema.isLoading}
          activeKey={selected ? `${selected.schema}.${selected.name}` : undefined}
          onPickTable={handlePickTable}
          onInsertIdent={handleInsertIdent}
        />

        {/* Right side */}
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
              <div className="border-b px-3 pt-2 shrink-0">
                <TabsList>
                  <TabsTrigger value="browse" className="gap-1">
                    <Database className="w-3.5 h-3.5" /> 浏览
                  </TabsTrigger>
                  <TabsTrigger value="query" className="gap-1">
                    <Code2 className="w-3.5 h-3.5" /> SQL
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="browse" className="flex-1 min-h-0 m-0 flex">
                {selected ? (
                  <BrowseTab nodeId={nodeId} table={selected} />
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
