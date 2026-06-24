"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { CheckCircle2, Clock, RotateCcw, XCircle } from "lucide-react"
import { dbStudioService } from "@/lib/api/services"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"

// QueryHistoryServer — the server-backed counterpart to the editor's local
// per-node history. The backend appends one row per executed statement
// (Phase 2A.6), so this list is the cross-session audit trail; it auto-refreshes
// every 10s while visible. Each row offers a one-click replay that loads the SQL
// back into the editor (it does NOT re-run — the operator presses 执行).
export const QUERY_HISTORY_KEY = (nodeId?: number) =>
  ["dbstudio", "query-history", nodeId ?? "all"] as const

interface Props {
  onReplay: (sql: string) => void
  nodeId?: number
}

export function QueryHistoryServer({ onReplay, nodeId }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_HISTORY_KEY(nodeId),
    queryFn: () =>
      dbStudioService.queryHistory
        .list({ node_id: nodeId, limit: 100 })
        .then((r) => r.history),
    refetchInterval: 10_000,
  })

  return (
    <ScrollArea className="h-full">
      {error ? (
        <div className="p-4 text-xs text-center text-destructive">
          加载失败：{(error as Error).message ?? "未知错误"}
        </div>
      ) : isLoading ? (
        <div className="p-4 text-xs text-center text-muted-foreground">加载中…</div>
      ) : (data ?? []).length === 0 ? (
        <div className="p-4 text-xs text-center text-muted-foreground">
          还没有服务端查询历史 — 执行一条 SQL 后会自动记录
        </div>
      ) : (
        <ul className="m-0 p-0 list-none">
          {data!.map((h) => (
            <li
              key={h.id}
              className="flex items-start gap-2 px-2 py-1.5 border-b last:border-b-0 hover:bg-muted/50"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  {h.status === "ok" ? (
                    <CheckCircle2 className="w-3 h-3 text-green-600" />
                  ) : (
                    <XCircle className="w-3 h-3 text-red-600" />
                  )}
                  <span>{new Date(h.executed_at).toLocaleString()}</span>
                  {h.duration_ms > 0 && (
                    <span className="tabular-nums">{h.duration_ms}ms</span>
                  )}
                  {h.row_count != null && (
                    <span className="tabular-nums">{h.row_count} 行</span>
                  )}
                </div>
                <code className="block text-[11px] font-mono truncate" title={h.sql}>
                  {h.sql.split("\n")[0]}
                </code>
                {h.error_text && (
                  <div className="text-[10px] text-red-600 truncate">{h.error_text}</div>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onReplay(h.sql)}
                className="h-6 px-1.5 text-[10px] gap-1 shrink-0"
                title="载入到编辑器（不自动执行）"
              >
                <RotateCcw className="w-3 h-3" /> 重放
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="p-1.5 text-[9px] text-muted-foreground flex items-center gap-1">
        <Clock className="w-2.5 h-2.5" /> 每 10 秒自动刷新
      </div>
    </ScrollArea>
  )
}
