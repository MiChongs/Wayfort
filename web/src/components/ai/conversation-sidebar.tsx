"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { useQuery } from "@tanstack/react-query"
import { usePathname } from "next/navigation"
import Link from "next/link"
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

  const buckets = React.useMemo(() => groupConversations(filtered), [filtered])

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

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {convs.isLoading && !convs.data && <SidebarSkeleton rows={5} />}
        {!convs.isLoading && filtered.length === 0 && (
          <div className="text-xs text-muted-foreground py-8 text-center px-3 leading-relaxed">
            {filter ? (
              <>
                没有匹配「<span className="font-mono">{filter}</span>」的对话
              </>
            ) : (
              <>还没有对话，<br />点击上方<span className="text-foreground">新对话</span>开始</>
            )}
          </div>
        )}
        {buckets.map((bucket) => (
          <section key={bucket.key} className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold px-3 mb-1 sticky top-0 bg-muted/60 backdrop-blur py-1 z-10 rounded">
              {bucket.label}
            </div>
            <ul className="space-y-1">
              <AnimatePresence initial={false}>
                {bucket.items.map((c) => (
                  <ConversationListItem
                    key={c.id}
                    conv={c}
                    agent={agentMap.get(c.agent_id)}
                    active={c.id === activeId}
                    onSelect={onAfterPick}
                  />
                ))}
              </AnimatePresence>
            </ul>
          </section>
        ))}
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
