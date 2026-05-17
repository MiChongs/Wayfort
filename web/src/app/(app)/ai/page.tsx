"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Plus, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { aiAgentService, aiConversationService } from "@/lib/api/services"
import { relTime } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select"

export default function AIHomePage() {
  const qc = useQueryClient()
  const convs = useQuery({ queryKey: ["ai", "convs"], queryFn: aiConversationService.list })
  const agents = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })

  const [open, setOpen] = React.useState(false)
  const [agentId, setAgentId] = React.useState("")
  const create = useMutation({
    mutationFn: () => aiConversationService.create({ agent_id: Number(agentId) }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      setOpen(false)
      window.location.href = `/ai/conversations/${c.id}`
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => aiConversationService.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "convs"] }),
  })

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Sparkles className="w-5 h-5" /> AI 助手
          </h1>
          <p className="text-sm text-muted-foreground mt-1">用对话的方式做运维。Agent 调用工具时会请求你的确认（normal 模式）。</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4" /> 新对话</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>选择一个 Agent</DialogTitle></DialogHeader>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger><SelectValue placeholder="选择 Agent" /></SelectTrigger>
              <SelectContent>
                {(agents.data?.agents || []).map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name} {a.scope === "global" ? "（全局）" : "（个人）"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
              <Button disabled={!agentId || create.isPending} onClick={() => create.mutate()}>开始对话</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {(agents.data?.agents?.length ?? 0) === 0 && (
        <div className="text-sm rounded-md border bg-muted px-3 py-2">
          <Bot className="w-4 h-4 inline mr-2" />
          还没有可用的 Agent。管理员可在 <Link className="text-primary hover:underline" href={"/admin/ai/agents" as Parameters<typeof Link>[0]["href"]}>AI Agent 管理</Link> 创建。
        </div>
      )}

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">标题</th>
              <th className="text-left px-3 py-2">Agent</th>
              <th className="text-left px-3 py-2">模式</th>
              <th className="text-left px-3 py-2">最后更新</th>
              <th className="text-right px-3 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {(convs.data?.conversations || []).map((c) => (
              <tr key={c.id} className="border-t hover:bg-accent/30">
                <td className="px-3 py-2">
                  <Link
                    href={`/ai/conversations/${c.id}` as Parameters<typeof Link>[0]["href"]}
                    className="font-medium hover:underline"
                  >
                    {c.title || "新对话"}
                  </Link>
                  <div className="text-xs text-muted-foreground">{c.message_count} 条消息</div>
                </td>
                <td className="px-3 py-2">{(agents.data?.agents || []).find((a) => a.id === c.agent_id)?.name || c.agent_id}</td>
                <td className="px-3 py-2"><Badge variant="outline">{c.permission_mode}</Badge></td>
                <td className="px-3 py-2 text-xs">{relTime(c.updated_at)}</td>
                <td className="px-3 py-2 text-right">
                  <Button variant="ghost" size="icon" onClick={() => remove.mutate(c.id)}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </td>
              </tr>
            ))}
            {convs.isLoading && <tr><td colSpan={5} className="text-center text-muted-foreground py-8">加载中…</td></tr>}
            {!convs.isLoading && (convs.data?.conversations?.length ?? 0) === 0 && (
              <tr><td colSpan={5} className="text-center text-muted-foreground py-8">还没有对话</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
