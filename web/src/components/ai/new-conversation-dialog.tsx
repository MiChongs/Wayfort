"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { Bot, Loader2, Search } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { aiAgentService, aiConversationService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import type { AIAgent } from "@/lib/api/types"

export function NewConversationDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const qc = useQueryClient()
  const reduce = useReducedMotion()
  const [filter, setFilter] = React.useState("")
  const agents = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })

  const create = useMutation({
    mutationFn: (agentId: number) =>
      aiConversationService.create({ agent_id: agentId }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      onOpenChange(false)
      router.push(`/ai/conversations/${c.id}` as Parameters<typeof router.push>[0])
    },
    onError: (e: unknown) =>
      toast.error("创建失败", { description: (e as Error).message }),
  })

  const filtered = React.useMemo(() => {
    const list = (agents.data?.agents || []).filter((a) => a.enabled !== false)
    if (!filter.trim()) return list
    const q = filter.toLowerCase()
    return list.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q),
    )
  }, [agents.data, filter])

  const groups = React.useMemo(() => {
    return {
      global: filtered.filter((a) => a.scope === "global" && !a.is_sub_agent),
      personal: filtered.filter((a) => a.scope === "personal" && !a.is_sub_agent),
    }
  }, [filtered])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-2">
          <DialogTitle>选择一个 Agent 开始对话</DialogTitle>
        </DialogHeader>
        <div className="px-5 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="搜索 Agent…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-8 h-9"
              autoFocus
            />
          </div>
        </div>

        <ScrollArea className="max-h-[60vh]">
          <div className="px-5 pb-5 space-y-4">
            {agents.isLoading && (
              <div className="text-sm text-muted-foreground text-center py-10">
                <Loader2 className="inline w-4 h-4 mr-1 animate-spin" /> 加载 Agent…
              </div>
            )}
            {!agents.isLoading && filtered.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-10">
                没有匹配的 Agent
              </div>
            )}

            <AnimatePresence>
              {(["global", "personal"] as const).map((scope) => {
                const items = groups[scope]
                if (items.length === 0) return null
                return (
                  <motion.section
                    key={scope}
                    initial={reduce ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={reduce ? { duration: 0 } : { duration: 0.2 }}
                  >
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                      {scope === "global" ? "全局 Agent" : "个人 Agent"}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {items.map((a, i) => (
                        <AgentCard
                          key={a.id}
                          agent={a}
                          index={i}
                          loading={
                            create.isPending && create.variables === a.id
                          }
                          onPick={() => create.mutate(a.id)}
                        />
                      ))}
                    </div>
                  </motion.section>
                )
              })}
            </AnimatePresence>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function AgentCard({
  agent,
  index,
  loading,
  onPick,
}: {
  agent: AIAgent
  index: number
  loading: boolean
  onPick: () => void
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduce
          ? { duration: 0 }
          : { duration: 0.25, delay: Math.min(index * 0.03, 0.18) }
      }
      whileHover={reduce ? undefined : { y: -2 }}
      whileTap={reduce ? undefined : { scale: 0.98 }}
    >
      <Card
        role="button"
        tabIndex={loading ? -1 : 0}
        aria-disabled={loading}
        onClick={() => !loading && onPick()}
        onKeyDown={(e) => {
          if (loading) return
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onPick()
          }
        }}
        className={cn(
          "cursor-pointer p-0 gap-0 transition-all hover:border-primary/40 hover:shadow-md",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          loading && "opacity-60 cursor-wait",
        )}
      >
        <CardContent className="p-3 flex items-start gap-2">
          <div className="w-7 h-7 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Bot className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm flex items-center gap-2">
              <span className="truncate">{agent.name}</span>
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                {agent.permission_mode}
              </Badge>
            </div>
            {agent.description && (
              <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                {agent.description}
              </div>
            )}
          </div>
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
        </CardContent>
      </Card>
    </motion.div>
  )
}
