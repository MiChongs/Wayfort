"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bookmark, Search, Trash2 } from "lucide-react"
import { dbStudioService } from "@/lib/api/services"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "@/components/ui/sonner"

// SavedQueriesServer — the server-backed replacement for the editor's old
// per-node localStorage snippet library (db.saved.<id>). It lists the caller's
// saved queries, filters by name/SQL, deletes, and hands a picked SQL back to
// the editor via onPick. Creation stays on the toolbar (the "收藏" button), so
// this panel is read + delete + pick only; SAVED_QUERIES_KEY is exported so the
// toolbar's create mutation can invalidate the same cache.
export const SAVED_QUERIES_KEY = ["dbstudio", "saved-queries"] as const

interface Props {
  onPick: (sql: string) => void
}

export function SavedQueriesServer({ onPick }: Props) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: SAVED_QUERIES_KEY,
    queryFn: () => dbStudioService.savedQueries.list().then((r) => r.queries),
  })
  const del = useMutation({
    mutationFn: (id: number) => dbStudioService.savedQueries.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SAVED_QUERIES_KEY })
      toast.success("已删除", { duration: 900 })
    },
    onError: (e: unknown) => toast.error("删除失败：" + ((e as Error).message ?? "")),
  })

  const [filter, setFilter] = React.useState("")
  const items = (data ?? []).filter((q) =>
    (q.name + "\n" + q.sql).toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="搜索收藏…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        {error ? (
          <div className="p-4 text-xs text-center text-destructive">
            加载失败：{(error as Error).message ?? "未知错误"}
          </div>
        ) : isLoading ? (
          <div className="p-4 text-xs text-center text-muted-foreground">加载中…</div>
        ) : items.length === 0 ? (
          <div className="p-4 text-xs text-center text-muted-foreground">
            还没有收藏 — 在工具栏点「收藏」保存当前 SQL
          </div>
        ) : (
          <ul className="m-0 p-0 list-none">
            {items.map((q) => (
              <li
                key={q.id}
                className="group flex items-start gap-2 px-2 py-1.5 border-b last:border-b-0 hover:bg-muted/50"
              >
                <button
                  type="button"
                  onClick={() => onPick(q.sql)}
                  className="flex-1 min-w-0 text-left"
                  title={q.sql}
                >
                  <div className="flex items-center gap-1 text-xs font-medium">
                    <Bookmark className="w-3 h-3 shrink-0 text-muted-foreground" />
                    {q.folder_path && (
                      <span className="text-muted-foreground">{q.folder_path} / </span>
                    )}
                    <span className="truncate">{q.name}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono truncate">
                    {q.sql.split("\n")[0]}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => del.mutate(q.id)}
                  disabled={del.isPending}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}

// Re-exported as a prop-less button so the editor toolbar can drop a create
// affordance without duplicating the mutation + invalidation wiring. Kept here
// because creation belongs to the saved-queries domain, not the editor shell.
export function SaveCurrentButton({
  disabled,
  onSave,
}: {
  disabled?: boolean
  onSave: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onSave}
      disabled={disabled}
      className="h-7 px-2 text-xs gap-1"
      title="把当前 SQL 收藏到服务端"
    >
      <Bookmark className="w-3.5 h-3.5" /> 收藏
    </Button>
  )
}
