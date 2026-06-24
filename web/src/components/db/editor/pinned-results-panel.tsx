"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, Pin, Trash2 } from "lucide-react"
import { dbStudioService } from "@/lib/api/services"
import type { PinnedResult } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "@/components/ui/sonner"

// PinnedResultsPanel — freeze a query result on the server for later
// side-by-side comparison. The editor passes the live result via `pinSource`
// (absent → the pin button stays disabled, since there's nothing to freeze).
// The list is metadata-only; clicking a row lazily fetches the decoded snapshot
// (GET /:id) and renders a compact read-only table. Pinned rows are gzipped on
// the server (≤ 50k rows / 10MB) so this stays cheap even for big result sets.
export const PINNED_RESULTS_KEY = ["dbstudio", "pinned-results"] as const

interface Props {
  nodeId: number
  pinSource?: { sql: string; rows: Record<string, unknown>[] }
}

export function PinnedResultsPanel({ nodeId, pinSource }: Props) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: PINNED_RESULTS_KEY,
    queryFn: () => dbStudioService.pinnedResults.list().then((r) => r.pinned),
  })

  const canPin = !!pinSource && pinSource.rows.length > 0
  const create = useMutation({
    mutationFn: () =>
      dbStudioService.pinnedResults.create({
        node_id: nodeId,
        sql: pinSource!.sql,
        rows: pinSource!.rows,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PINNED_RESULTS_KEY })
      toast.success("已固定当前结果", { duration: 900 })
    },
    onError: (e: unknown) => toast.error("固定失败：" + ((e as Error).message ?? "")),
  })
  const del = useMutation({
    mutationFn: (id: number) => dbStudioService.pinnedResults.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PINNED_RESULTS_KEY })
      toast.success("已删除", { duration: 900 })
    },
    onError: (e: unknown) => toast.error("删除失败：" + ((e as Error).message ?? "")),
  })

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b">
        <Button
          type="button"
          size="sm"
          onClick={() => create.mutate()}
          disabled={!canPin || create.isPending}
          className="h-7 w-full gap-1 text-xs"
          title={canPin ? "固定当前结果快照" : "执行查询后才能固定"}
        >
          <Pin className="w-3.5 h-3.5" />
          {create.isPending ? "固定中…" : "固定当前结果"}
        </Button>
        {!canPin && (
          <div className="mt-1 text-[10px] text-muted-foreground text-center">
            先执行一条查询，再回来固定结果
          </div>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {error ? (
          <div className="p-4 text-xs text-center text-destructive">
            加载失败：{(error as Error).message ?? "未知错误"}
          </div>
        ) : isLoading ? (
          <div className="p-4 text-xs text-center text-muted-foreground">加载中…</div>
        ) : (data ?? []).length === 0 ? (
          <div className="p-4 text-xs text-center text-muted-foreground">还没有固定的结果</div>
        ) : (
          <ul className="m-0 p-0 list-none">
            {data!.map((p) => (
              <PinnedRow key={p.id} pinned={p} onDelete={() => del.mutate(p.id)} deleting={del.isPending} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

// PinnedRow lazily decodes the snapshot only when expanded — the list payload
// deliberately omits rows to stay small, so the fetch happens on demand.
function PinnedRow({
  pinned,
  onDelete,
  deleting,
}: {
  pinned: PinnedResult
  onDelete: () => void
  deleting: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const { data, isFetching } = useQuery({
    queryKey: ["dbstudio", "pinned-results", pinned.id],
    queryFn: () => dbStudioService.pinnedResults.get(pinned.id),
    enabled: open,
    staleTime: 60_000,
  })
  const rows = data?.rows ?? []
  const cols = rows.length ? Object.keys(rows[0]) : []

  return (
    <li className="border-b last:border-b-0">
      <div className="group flex items-start gap-1 px-2 py-1.5 hover:bg-muted/50">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-1 text-xs">
            {open ? (
              <ChevronDown className="w-3 h-3 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 shrink-0" />
            )}
            <Pin className="w-3 h-3 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground tabular-nums">{pinned.row_count} 行</span>
            {pinned.truncated && (
              <span className="text-[9px] text-amber-600" title="超过 5 万行 / 10MB，已截断">
                截断
              </span>
            )}
          </div>
          <code className="block text-[10px] font-mono text-muted-foreground truncate" title={pinned.sql}>
            {pinned.sql.split("\n")[0]}
          </code>
          <div className="text-[9px] text-muted-foreground">
            {new Date(pinned.executed_at).toLocaleString()}
          </div>
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
          title="删除"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {open && (
        <div className="px-2 pb-2">
          {isFetching ? (
            <div className="text-[10px] text-muted-foreground">解码快照…</div>
          ) : rows.length === 0 ? (
            <div className="text-[10px] text-muted-foreground">空结果</div>
          ) : (
            <div className="overflow-auto max-h-60 rounded border">
              <table className="w-full text-[10px] border-collapse">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    {cols.map((c) => (
                      <th key={c} className="text-left font-medium px-1.5 py-0.5 border-b whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 100).map((r, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      {cols.map((c) => {
                        const v = r[c]
                        return (
                          <td key={c} className="px-1.5 py-0.5 whitespace-nowrap overflow-hidden text-ellipsis max-w-[12rem]">
                            {v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 100 && (
                <div className="px-1.5 py-0.5 text-[9px] text-muted-foreground border-t">
                  仅显示前 100 行（共 {rows.length}）
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

