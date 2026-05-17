"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Bot, Plus, Sparkles, ArrowRight, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { aiAgentService, aiConversationService } from "@/lib/api/services"
import { NewConversationDialog } from "@/components/ai/new-conversation-dialog"
import { cn } from "@/lib/utils"
import type { AIAgent } from "@/lib/api/types"

const SUGGESTIONS = [
  "帮我检查所有节点的磁盘使用率，超过 80% 的列出来",
  "查询最近 24 小时内失败的会话，按用户分组统计",
  "列出我有 ssh 访问权限的节点",
  "诊断 prod-web-1 的负载情况，输出健康报告",
]

export default function AIHomePage() {
  const router = useRouter()
  const qc = useQueryClient()
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(false)

  const agents = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })
  const featured = React.useMemo(() => {
    return (agents.data?.agents || [])
      .filter((a) => a.enabled !== false && !a.is_sub_agent)
      .sort((a, b) => (a.scope === "global" ? -1 : 1))
      .slice(0, 6)
  }, [agents.data])

  const quickStart = useMutation({
    mutationFn: (agentId: number) =>
      aiConversationService.create({ agent_id: agentId }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      router.push(`/ai/conversations/${c.id}` as Parameters<typeof router.push>[0])
    },
    onError: (e: unknown) =>
      toast.error("创建失败", { description: (e as Error).message }),
  })

  const noAgents = !agents.isLoading && featured.length === 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 md:px-8 py-10 md:py-16 space-y-10">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.4, ease: "easeOut" }}
          className="text-center space-y-3"
        >
          <motion.div
            initial={reduce ? false : { scale: 0.6, rotate: -20, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 220, damping: 18 }}
            className="inline-flex w-14 h-14 rounded-2xl bg-primary/10 text-primary items-center justify-center"
          >
            <Sparkles className="w-7 h-7" />
          </motion.div>
          <h1 className="text-3xl font-semibold tracking-tight">AI 助手</h1>
          <p className="text-sm md:text-base text-muted-foreground max-w-2xl mx-auto">
            用对话的方式做运维。Agent 调用敏感工具时会在 normal 模式下请求你的确认；
            plan 模式只规划不动手；bypass 模式直接执行。
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <Button onClick={() => setOpen(true)}>
              <Plus className="w-4 h-4" /> 开始新对话
            </Button>
            <Button
              variant="outline"
              onClick={() => router.push("/ai/agents" as Parameters<typeof router.push>[0])}
            >
              <Bot className="w-4 h-4" /> 管理 Agent
            </Button>
          </div>
        </motion.div>

        {noAgents && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-sm text-center"
          >
            <Bot className="w-4 h-4 inline mr-1 align-middle" />
            还没有可用的 Agent。前往
            <Link
              className="text-primary hover:underline mx-1"
              href={"/admin/ai/agents" as Parameters<typeof Link>[0]["href"]}
            >
              AI Agent 管理
            </Link>
            创建第一个。
          </motion.div>
        )}

        {agents.isLoading && (
          <div className="text-center text-sm text-muted-foreground py-6">
            <Loader2 className="inline w-4 h-4 mr-1 animate-spin" /> 加载 Agent…
          </div>
        )}

        {featured.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">
                推荐 Agent
              </h2>
              <Link
                href={"/ai/agents" as Parameters<typeof Link>[0]["href"]}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                查看全部 <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {featured.map((a, i) => (
                <AgentTile
                  key={a.id}
                  agent={a}
                  index={i}
                  loading={quickStart.isPending && quickStart.variables === a.id}
                  onStart={() => quickStart.mutate(a.id)}
                />
              ))}
            </div>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">试试这些</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {SUGGESTIONS.map((s, i) => (
              <motion.button
                key={s}
                type="button"
                onClick={() => setOpen(true)}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { duration: 0.3, delay: 0.1 + i * 0.05, ease: "easeOut" }
                }
                whileHover={reduce ? undefined : { y: -2 }}
                whileTap={reduce ? undefined : { scale: 0.98 }}
                className="text-left rounded-lg border bg-card hover:bg-accent/40 hover:border-primary/40 transition-all px-3 py-2.5 text-sm"
              >
                <span className="line-clamp-2">{s}</span>
              </motion.button>
            ))}
          </div>
        </section>
      </div>

      <NewConversationDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}

function AgentTile({
  agent,
  index,
  loading,
  onStart,
}: {
  agent: AIAgent
  index: number
  loading: boolean
  onStart: () => void
}) {
  const reduce = useReducedMotion()
  return (
    <motion.button
      type="button"
      onClick={onStart}
      disabled={loading}
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduce
          ? { duration: 0 }
          : { duration: 0.3, delay: Math.min(index * 0.05, 0.3) }
      }
      whileHover={reduce ? undefined : { y: -3 }}
      whileTap={reduce ? undefined : { scale: 0.98 }}
      className={cn(
        "text-left rounded-xl border bg-card hover:border-primary/40 hover:shadow-lg transition-all p-4 group",
        loading && "opacity-60 cursor-wait",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          <Bot className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{agent.name}</div>
          <div className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Badge
              variant="outline"
              className="text-[9px] h-3.5 px-1 leading-none"
            >
              {agent.scope === "global" ? "全局" : "个人"}
            </Badge>
            <Badge
              variant="outline"
              className="text-[9px] h-3.5 px-1 leading-none"
            >
              {agent.permission_mode}
            </Badge>
          </div>
        </div>
      </div>
      {agent.description && (
        <p className="text-xs text-muted-foreground line-clamp-3 mb-3">
          {agent.description}
        </p>
      )}
      <div className="flex items-center justify-end text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">
        开始对话 <ArrowRight className="w-3 h-3 ml-1" />
        {loading && <Loader2 className="w-3 h-3 ml-1 animate-spin" />}
      </div>
    </motion.button>
  )
}
