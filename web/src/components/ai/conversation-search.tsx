"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, X, ArrowUp, ArrowDown } from "lucide-react"
import { Input } from "@/components/ui/input"
import { aiConversationService } from "@/lib/api/services"
import { cn } from "@/lib/utils"

const ROLE_LABEL: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  tool: "工具",
  system: "系统",
}

// In-conversation search overlay (Cmd/Ctrl+F). Queries the backend for matching
// message ids + snippets and lets the user jump/cycle through hits, which the
// page scrolls to in the virtualized message list and highlights.
export function ConversationSearch({
  conversationId,
  onClose,
  onJump,
}: {
  conversationId: string
  onClose: () => void
  onJump: (messageId: number) => void
}) {
  const [q, setQ] = React.useState("")
  const [debounced, setDebounced] = React.useState("")
  const [cursor, setCursor] = React.useState(0)

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  const { data, isFetching } = useQuery({
    queryKey: ["ai", "conv-search", conversationId, debounced],
    queryFn: () => aiConversationService.searchMessages(conversationId, debounced),
    enabled: debounced.length >= 1,
    staleTime: 10_000,
  })
  const hits = React.useMemo(() => data?.hits ?? [], [data])

  React.useEffect(() => {
    setCursor(0)
  }, [debounced])

  const go = React.useCallback(
    (dir: 1 | -1) => {
      if (!hits.length) return
      const next = (cursor + dir + hits.length) % hits.length
      setCursor(next)
      onJump(hits[next].message_id)
    },
    [hits, cursor, onJump],
  )

  return (
    <div className="absolute left-1/2 top-3 z-20 w-[min(560px,calc(100%-2rem))] -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/95 px-2.5 py-1.5 shadow-sm backdrop-blur">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索本对话…"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              go(e.shiftKey ? -1 : 1)
            }
            if (e.key === "Escape") {
              e.preventDefault()
              onClose()
            }
          }}
          className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {hits.length ? `${cursor + 1}/${hits.length}` : debounced && !isFetching ? "0" : ""}
        </span>
        <SearchIconButton label="上一个" disabled={!hits.length} onClick={() => go(-1)}>
          <ArrowUp className="h-3.5 w-3.5" />
        </SearchIconButton>
        <SearchIconButton label="下一个" disabled={!hits.length} onClick={() => go(1)}>
          <ArrowDown className="h-3.5 w-3.5" />
        </SearchIconButton>
        <SearchIconButton label="关闭" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </SearchIconButton>
      </div>
      {hits.length > 0 && (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-border/70 bg-background/95 shadow-sm backdrop-blur">
          {hits.map((h, i) => (
            <button
              key={h.message_id}
              type="button"
              onClick={() => {
                setCursor(i)
                onJump(h.message_id)
              }}
              className={cn(
                "block w-full px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50",
                i === cursor && "bg-accent",
              )}
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {ROLE_LABEL[h.role] ?? h.role}
              </span>
              <p className="truncate text-foreground/80">{h.snippet}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SearchIconButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {children}
    </button>
  )
}
