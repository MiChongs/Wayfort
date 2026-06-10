"use client"

import * as React from "react"
import { BookOpen, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import type { AIKnowledgeBase } from "@/lib/api/types"

// KbMultiSelect — a flat, searchable checkbox list of knowledge bases an agent
// may search via knowledge_search. Mirrors ToolMultiSelect's interaction model
// but without families (knowledge bases are flat).
export function KbMultiSelect({
  knowledgeBases,
  selected,
  onChange,
}: {
  knowledgeBases: AIKnowledgeBase[]
  selected: number[]
  onChange: (ids: number[]) => void
}) {
  const [q, setQ] = React.useState("")
  const sel = React.useMemo(() => new Set(selected), [selected])

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return knowledgeBases
    return knowledgeBases.filter(
      (kb) =>
        kb.name.toLowerCase().includes(needle) ||
        (kb.description ?? "").toLowerCase().includes(needle),
    )
  }, [knowledgeBases, q])

  const toggle = (id: number) => {
    const next = new Set(sel)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange([...next])
  }

  if (knowledgeBases.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
        暂无知识库。先在「AI 知识库」中创建并上传文档。
      </p>
    )
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索知识库…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {selected.length > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">已选 {selected.length}</span>
        )}
      </div>
      <div className="max-h-52 overflow-y-auto p-1">
        {filtered.map((kb) => {
          const checked = sel.has(kb.id)
          return (
            <button
              key={kb.id}
              type="button"
              onClick={() => toggle(kb.id)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60",
                checked && "bg-muted/50",
              )}
            >
              <Checkbox checked={checked} className="pointer-events-none" />
              <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{kb.name}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {kb.document_count} 文档
              </span>
            </button>
          )
        })}
        {filtered.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">无匹配</p>
        )}
      </div>
    </div>
  )
}
