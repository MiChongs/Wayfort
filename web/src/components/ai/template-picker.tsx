"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Pin, Search } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { snippetService } from "@/lib/api/services"

// Prompt-template picker — reuses the user's saved snippets (/me/snippets) as
// reusable prompt templates. Selecting one inserts its body into the composer.
export function TemplatePicker({
  onPick,
  children,
}: {
  onPick: (body: string) => void
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState("")
  const snippets = useQuery({
    queryKey: ["snippets"],
    queryFn: snippetService.list,
    enabled: open,
    staleTime: 30_000,
  })
  const items = React.useMemo(() => {
    const list = snippets.data?.snippets || []
    const f = q.trim().toLowerCase()
    const filtered = f
      ? list.filter(
          (s) =>
            s.name.toLowerCase().includes(f) || (s.description || "").toLowerCase().includes(f),
        )
      : list
    return [...filtered].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  }, [snippets.data, q])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[min(340px,calc(100vw-2rem))] p-0">
        <div className="border-b border-border/60 p-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索提示词模板…"
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="max-h-[300px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
              {snippets.isLoading ? "加载中…" : q ? "无匹配模板" : "还没有模板，可在「片段」中创建后在此引用"}
            </div>
          ) : (
            items.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onPick(s.body)
                  setOpen(false)
                  setQ("")
                }}
                className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus:outline-none focus-visible:bg-accent"
              >
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {s.pinned && <Pin className="h-3 w-3 shrink-0 text-primary" aria-hidden />}
                  <span className="truncate">{s.name}</span>
                </div>
                {s.description ? (
                  <p className="truncate text-[11px] text-muted-foreground">{s.description}</p>
                ) : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
