"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Brain, Pencil, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import { DataTable, type Column } from "@/components/common/data-table"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { aiAgentService, aiMemoryService } from "@/lib/api/services"
import type { AIMemory } from "@/lib/api/types"
import { relTime } from "@/lib/format"
import Link from "next/link"

const KIND_LABEL: Record<string, string> = { fact: "事实", preference: "偏好", resolution: "排障" }

export default function AIMemoryPage() {
  const qc = useQueryClient()
  const [agentId, setAgentId] = React.useState<number | undefined>(undefined)
  const [q, setQ] = React.useState("")
  const [debouncedQ, setDebouncedQ] = React.useState("")
  const [editing, setEditing] = React.useState<AIMemory | null>(null)

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(t)
  }, [q])

  const agents = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })
  const memories = useQuery({
    queryKey: ["ai", "memories", agentId, debouncedQ],
    queryFn: () => aiMemoryService.list({ agent_id: agentId, q: debouncedQ || undefined }),
  })

  const remove = useMutation({
    mutationFn: (id: number) => aiMemoryService.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ai", "memories"] }); toast.success("已删除") },
  })

  const agentName = React.useMemo(() => {
    const m = new Map<number, string>()
    for (const a of agents.data?.agents ?? []) m.set(a.id, a.name)
    return m
  }, [agents.data])

  const cols: Column<AIMemory>[] = [
    { header: "分类", cell: (m) => <Badge variant="outline">{KIND_LABEL[m.kind] ?? m.kind}</Badge> },
    { header: "内容", cell: (m) => <span className="line-clamp-2 max-w-xl text-sm">{m.content}</span> },
    {
      header: "智能体",
      cell: (m) => <span className="text-xs text-muted-foreground">{agentName.get(m.agent_id) ?? `#${m.agent_id}`}</span>,
    },
    {
      header: "显著度",
      className: "tabular-nums",
      cell: (m) => <span className="text-xs text-muted-foreground" title="被召回次数越多越高">{m.salience}</span>,
    },
    {
      header: "来源会话",
      cell: (m) => m.source_conversation_id
        ? <Link href={`/ai/conversations/${m.source_conversation_id}`} className="text-xs text-primary hover:underline">查看</Link>
        : <span className="text-xs text-muted-foreground">—</span>,
    },
    { header: "更新", cell: (m) => <span className="text-xs text-muted-foreground">{relTime(m.updated_at)}</span> },
    {
      header: "操作", className: "text-right",
      cell: (m) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" title="编辑" onClick={() => setEditing(m)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost" size="icon" title="删除"
            onClick={async () => {
              const ok = await confirmDialog({ title: "删除这条记忆？", destructive: true })
              if (ok) remove.mutate(m.id)
            }}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Brain className="h-5 w-5" /> AI 记忆
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          智能体跨会话记住的用户/项目事实。开启「跨会话长期记忆」的智能体会在每轮自动召回相关记忆。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={agentId ? String(agentId) : "all"} onValueChange={(v) => setAgentId(v === "all" ? undefined : Number(v))}>
          <SelectTrigger className="w-56"><SelectValue placeholder="全部智能体" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部智能体</SelectItem>
            {(agents.data?.agents ?? []).map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索记忆内容…" className="w-64" />
      </div>

      <DataTable columns={cols} rows={memories.data?.memories} loading={memories.isLoading} virtualize />

      {editing && (
        <MemoryEditSheet
          memory={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["ai", "memories"] }) }}
        />
      )}
    </div>
  )
}

function MemoryEditSheet({ memory, onClose, onSaved }: { memory: AIMemory; onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = React.useState(memory.content)
  const save = useMutation({
    mutationFn: () => aiMemoryService.update(memory.id, content),
    onSuccess: () => { toast.success("已保存"); onSaved() },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader><SheetTitle className="flex items-center gap-2"><Pencil className="h-4 w-4" /> 编辑记忆</SheetTitle></SheetHeader>
        <div className="mt-4 space-y-2">
          <Label>内容</Label>
          <Textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={!content || save.isPending}>保存</Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
