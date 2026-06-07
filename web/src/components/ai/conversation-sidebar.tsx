"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { useQuery } from "@tanstack/react-query"
import { usePathname } from "next/navigation"
import Link from "next/link"
import { GroupedVirtuoso } from "react-virtuoso"
import { Plus, Search, Sparkles, Bot, Cpu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { aiAgentService, aiConversationService } from "@/lib/api/services"
import { groupConversations } from "@/lib/ai/group"
import { cn } from "@/lib/utils"
import { ConversationListItem } from "./conversation-list-item"
import { NewConversationDialog } from "./new-conversation-dialog"
import { SidebarSkeleton } from "./sidebar-skeleton"
import { Archive, ChevronDown, Pin } from "lucide-react"
import type { AIConversation } from "@/lib/api/types"

export function ConversationSidebar({
  className,
  onAfterPick,
}: {
  className?: string
  onAfterPick?: () => void
}) {
  const pathname = usePathname()
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(false)
  const [filter, setFilter] = React.useState("")

  const convs = useQuery({
    queryKey: ["ai", "convs"],
    queryFn: aiConversationService.list,
    refetchInterval: 30_000,
  })
  const agents = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })

  const activeId = React.useMemo(() => {
    if (!pathname) return undefined
    const m = pathname.match(/\/ai\/conversations\/([^/]+)/)
    return m?.[1]
  }, [pathname])

  const agentMap = React.useMemo(() => {
    const m = new Map<number, import("@/lib/api/types").AIAgent>()
    for (const a of agents.data?.agents || []) m.set(a.id, a)
    return m
  }, [agents.data])

  // Client-side filter on title + agent name (instant). For longer queries
  // we ALSO hit the server's /conversations/search endpoint to surface hits
  // that live in message content, not just titles.
  const filtered = React.useMemo(() => {
    const list = convs.data?.conversations || []
    const q = filter.trim().toLowerCase()
    if (!q) return list
    return list.filter((c) => {
      const ag = agentMap.get(c.agent_id)
      return (
        (c.title || "新对话").toLowerCase().includes(q) ||
        (ag?.name || "").toLowerCase().includes(q)
      )
    })
  }, [convs.data, filter, agentMap])

  // Split into pinned / active / archived for visual grouping.
  const { pinned, active, archived } = React.useMemo(() => {
    const pinned: typeof filtered = []
    const active: typeof filtered = []
    const archived: typeof filtered = []
    for (const c of filtered) {
      if (c.archived) archived.push(c)
      else if (c.pinned) pinned.push(c)
      else active.push(c)
    }
    return { pinned, active, archived }
  }, [filtered])

  const buckets = React.useMemo(() => groupConversations(active), [active])

  // Debounced full-text search across messages — only kicks in for queries
  // ≥ 2 chars, ignored on empty.
  const [debouncedFilter, setDebouncedFilter] = React.useState("")
  React.useEffect(() => {
    const handle = setTimeout(() => setDebouncedFilter(filter.trim()), 300)
    return () => clearTimeout(handle)
  }, [filter])

  const search = useQuery({
    queryKey: ["ai", "convs", "search", debouncedFilter],
    queryFn: () => aiConversationService.search(debouncedFilter),
    enabled: debouncedFilter.length >= 2,
    staleTime: 10_000,
  })

  const searchExtraIDs = React.useMemo(() => {
    const have = new Set(filtered.map((c) => c.id))
    return (search.data?.conversations || []).filter((c) => !have.has(c.id))
  }, [search.data, filtered])

  // Archived is collapsed by default; when closed we omit its items from the
  // flattened model so GroupedVirtuoso renders only the (still-clickable) header.
  const [archivedOpen, setArchivedOpen] = React.useState(false)

  // Flatten pinned / date buckets / full-text hits / archived into the
  // (groupCounts, flatItems) shape GroupedVirtuoso consumes. Sticky group
  // headers replace the old per-section sticky labels; rows recycle.
  const sections = React.useMemo(() => {
    const s: { key: string; header: React.ReactNode; items: AIConversation[] }[] = []
    if (pinned.length)
      s.push({ key: "pinned", header: <SectionLabel icon={Pin}>置顶</SectionLabel>, items: pinned })
    for (const b of buckets)
      s.push({ key: b.key, header: <SectionLabel>{b.label}</SectionLabel>, items: b.items })
    if (searchExtraIDs.length)
      s.push({
        key: "search",
        header: <SectionLabel icon={Search}>{`全文匹配 (${searchExtraIDs.length})`}</SectionLabel>,
        items: searchExtraIDs,
      })
    if (archived.length)
      s.push({
        key: "archived",
        header: (
          <button
            type="button"
            onClick={() => setArchivedOpen((o) => !o)}
            className="group inline-flex w-full items-center gap-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("h-3 w-3 transition-transform", !archivedOpen && "-rotate-90")} />
            <Archive className="h-2.5 w-2.5" /> 已归档 ({archived.length})
          </button>
        ),
        items: archivedOpen ? archived : [],
      })
    return s
  }, [pinned, buckets, searchExtraIDs, archived, archivedOpen])

  const groupCounts = React.useMemo(() => sections.map((s) => s.items.length), [sections])
  const flatItems = React.useMemo(() => sections.flatMap((s) => s.items), [sections])
  const hasAny = filtered.length > 0 || searchExtraIDs.length > 0

  return (
    <aside
      className={cn(
        "h-full flex flex-col bg-muted/30 border-r min-w-0",
        className,
      )}
    >
      <div className="p-3 space-y-2 border-b bg-background/40 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/ai"
            onClick={onAfterPick}
            className="inline-flex items-center gap-2 font-semibold tracking-tight"
          >
            <span className="w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </span>
            <span>AI 助手</span>
          </Link>
        </div>
        <motion.div whileTap={reduce ? undefined : { scale: 0.98 }}>
          <Button
            onClick={() => setOpen(true)}
            className="w-full justify-start gap-2"
            size="sm"
          >
            <Plus className="w-4 h-4" /> 新对话
          </Button>
        </motion.div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索对话…"
            className="pl-7 h-8 text-sm bg-background"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {convs.isLoading && !convs.data ? (
          <div className="px-2 pt-2">
            <SidebarSkeleton rows={5} />
          </div>
        ) : !hasAny ? (
          <div className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground">
            {filter ? (
              <>
                没有匹配「<span className="font-mono">{filter}</span>」的对话
              </>
            ) : (
              <>
                还没有对话，
                <br />
                点击上方<span className="text-foreground">新对话</span>开始
              </>
            )}
          </div>
        ) : (
          <GroupedVirtuoso
            className="no-scrollbar h-full"
            groupCounts={groupCounts}
            groupContent={(i) => (
              <div className="bg-muted/80 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
                {sections[i]?.header}
              </div>
            )}
            itemContent={(i) => {
              const c = flatItems[i]
              if (!c) return null
              return (
                <div className="px-2 pb-1">
                  <ConversationListItem
                    virtualized
                    conv={c}
                    agent={agentMap.get(c.agent_id)}
                    active={c.id === activeId}
                    onSelect={onAfterPick}
                  />
                </div>
              )
            }}
            computeItemKey={(i) => flatItems[i]?.id ?? i}
          />
        )}
      </div>

      <div className="border-t px-2 py-2 bg-background/30 space-y-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={"/ai/agents" as Parameters<typeof Link>[0]["href"]}
              onClick={onAfterPick}
              className="text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded px-2 py-1.5 flex items-center gap-2"
            >
              <Bot className="w-3.5 h-3.5" /> Agent 库
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">浏览或创建 Agent</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={"/ai/providers" as Parameters<typeof Link>[0]["href"]}
              onClick={onAfterPick}
              className="text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded px-2 py-1.5 flex items-center gap-2"
            >
              <Cpu className="w-3.5 h-3.5" /> 提供商
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">管理模型提供商与密钥</TooltipContent>
        </Tooltip>
      </div>

      <NewConversationDialog open={open} onOpenChange={setOpen} />
    </aside>
  )
}

function SectionLabel({
  icon: Icon,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="inline-flex items-center gap-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {Icon ? <Icon className="h-2.5 w-2.5" /> : null}
      {children}
    </div>
  )
}
