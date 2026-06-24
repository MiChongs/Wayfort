"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bookmark, Plus, Trash2 } from "lucide-react"
import { dbStudioService } from "@/lib/api/services"
import type { ViewProfile } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface CurrentView {
  filter: unknown
  sort: unknown
  columns: string[]
}

interface Props {
  nodeId: number
  tableFqn: string
  current: CurrentView
  onApply: (profile: ViewProfile) => void
}

// ViewProfiles — Phase 2C.2. A bookmark-style dropdown that recalls a named
// filter/sort/column combo for the current table. "+ 保存视图" snapshots the
// active view (debounced filter + order + visible columns) to the server; the
// trash dropdown deletes a stored profile. Applying a profile calls onApply,
// which the BrowseTab wires back into its filter/sort state.
export function ViewProfiles({ nodeId, tableFqn, current, onApply }: Props) {
  const qc = useQueryClient()
  const queryKey = ["view-profiles", nodeId, tableFqn] as const

  const listQuery = useQuery({
    queryKey,
    queryFn: () => dbStudioService.viewProfiles.list(nodeId, tableFqn),
  })
  const profiles = listQuery.data?.profiles ?? []

  const create = useMutation({
    mutationFn: (name: string) =>
      dbStudioService.viewProfiles.create({
        node_id: nodeId,
        table_fqn: tableFqn,
        name,
        filter_json: safeStringify(current.filter),
        sort_json: safeStringify(current.sort),
        columns_json: safeStringify(current.columns),
        is_default: false,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })
  const remove = useMutation({
    mutationFn: (id: number) => dbStudioService.viewProfiles.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  })

  return (
    <div className="flex items-center gap-1">
      <Bookmark className="w-3.5 h-3.5 text-muted-foreground" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={!listQuery.data}
            title="应用已保存的视图（筛选/排序/列）"
          >
            视图
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel className="text-[10px] text-muted-foreground">
            已保存视图
          </DropdownMenuLabel>
          {profiles.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无 — 点「保存视图」</div>
          ) : (
            profiles.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onApply(p)}>
                <span className="flex-1 truncate">
                  {p.is_default ? "⭐ " : ""}
                  {p.name}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 text-xs"
        title="把当前的筛选 / 排序保存为命名视图"
        disabled={create.isPending}
        onClick={() => {
          const name = window.prompt("视图名称？", "我的视图")
          if (name?.trim()) create.mutate(name.trim())
        }}
      >
        <Plus className="w-3.5 h-3.5" /> 保存视图
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            title="删除已保存视图"
            disabled={profiles.length === 0}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel className="text-[10px] text-muted-foreground">删除视图</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {profiles.map((p) => (
            <DropdownMenuItem key={p.id} onClick={() => remove.mutate(p.id)}>
              删除「{p.name}」
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// safeStringify — empty string when there's nothing worth persisting so the
// server stores NULL-ish rather than the literal "\"\"". Round-trips through
// JSON.parse on apply; bad JSON is swallowed by the caller.
function safeStringify(v: unknown): string {
  if (v === undefined || v === null || v === "") return ""
  if (Array.isArray(v) && v.length === 0) return ""
  try {
    return JSON.stringify(v)
  } catch {
    return ""
  }
}
