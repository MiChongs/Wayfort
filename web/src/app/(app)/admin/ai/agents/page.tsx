"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { aiAgentService, aiProviderService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import type { AIAgent, AITool, PermissionMode } from "@/lib/api/types"

export default function AIAgentsPage() {
  const qc = useQueryClient()
  const me = useCurrentUser()
  const list = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })
  const providers = useQuery({ queryKey: ["ai", "providers"], queryFn: aiProviderService.list })
  const tools = useQuery({ queryKey: ["ai", "tools"], queryFn: aiAgentService.tools })
  const remove = useMutation({
    mutationFn: (id: number) => aiAgentService.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "agents"] }),
  })

  const columns: Column<AIAgent>[] = [
    { header: "名称", cell: (a) => <span className="font-medium">{a.name}</span> },
    { header: "范围", cell: (a) => a.scope === "global" ? <Badge variant="success">global</Badge> : <Badge variant="outline">personal</Badge> },
    { header: "模型", cell: (a) => `${a.default_model || "—"}` },
    { header: "权限模式", cell: (a) => <Badge variant="secondary">{a.permission_mode}</Badge> },
    { header: "可用工具", cell: (a) => <span className="text-xs text-muted-foreground">{(parseList(a.allowed_tools)).length} 个</span> },
    {
      header: "操作", className: "text-right",
      cell: (a) => (
        <Button variant="ghost" size="icon" onClick={() => confirm("确认删除？") && remove.mutate(a.id)}>
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Bot className="w-5 h-5" /> AI Agent
        </h1>
        <CreateDialog
          providers={providers.data?.providers || []}
          tools={tools.data?.tools || []}
          canBeGlobal={!!me?.adm}
          onCreated={() => qc.invalidateQueries({ queryKey: ["ai", "agents"] })}
        />
      </div>
      <DataTable columns={columns} rows={list.data?.agents} loading={list.isLoading} />
    </div>
  )
}

function parseList(s: string): string[] {
  try { return JSON.parse(s || "[]") } catch { return s.split(",").filter(Boolean) }
}

function CreateDialog({
  providers, tools, canBeGlobal, onCreated,
}: {
  providers: { id: number; name: string; default_model?: string }[]
  tools: AITool[]
  canBeGlobal: boolean
  onCreated: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [a, setA] = React.useState<Partial<AIAgent>>({
    name: "", description: "", scope: "personal", system_prompt: "",
    default_model: "", permission_mode: "normal", max_iterations: 20,
    is_sub_agent: false, allowed_tools: "[]",
  })
  const [selectedTools, setSelectedTools] = React.useState<string[]>([])

  const create = useMutation({
    mutationFn: () => aiAgentService.create({ ...a, allowed_tools: JSON.stringify(selectedTools) }),
    onSuccess: () => { setOpen(false); onCreated(); toast.success("已创建 Agent") },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建 Agent</Button></DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>新建 Agent</DialogTitle></DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>名称</Label><Input value={a.name || ""} onChange={(e) => setA({ ...a, name: e.target.value })} /></div>
            <div className="space-y-1">
              <Label>范围</Label>
              <Select value={a.scope} onValueChange={(v) => setA({ ...a, scope: v as "global" | "personal" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">个人（仅自己可见）</SelectItem>
                  {canBeGlobal && <SelectItem value="global">全局（所有用户可见）</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1"><Label>描述</Label><Input value={a.description || ""} onChange={(e) => setA({ ...a, description: e.target.value })} /></div>
          <div className="space-y-1">
            <Label>System Prompt</Label>
            <Textarea rows={6} value={a.system_prompt || ""} onChange={(e) => setA({ ...a, system_prompt: e.target.value })}
              placeholder="你是 SRE 助手，帮助用户诊断和修复线上问题。回答简洁，必要时调用工具拿数据。" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>默认提供商</Label>
              <Select value={a.default_provider_id ? String(a.default_provider_id) : ""} onValueChange={(v) => setA({ ...a, default_provider_id: Number(v) })}>
                <SelectTrigger><SelectValue placeholder="可选" /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>默认模型</Label><Input value={a.default_model || ""} onChange={(e) => setA({ ...a, default_model: e.target.value })} placeholder="如 gpt-4o-mini" /></div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>权限模式</Label>
              <Select value={a.permission_mode} onValueChange={(v) => setA({ ...a, permission_mode: v as PermissionMode })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="plan">plan</SelectItem>
                  <SelectItem value="normal">normal</SelectItem>
                  <SelectItem value="bypass">bypass</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>最大迭代</Label><Input type="number" value={a.max_iterations || 20} onChange={(e) => setA({ ...a, max_iterations: Number(e.target.value) })} /></div>
            <div className="space-y-1 flex items-center gap-2 pt-6">
              <Switch checked={!!a.is_sub_agent} onCheckedChange={(v) => setA({ ...a, is_sub_agent: v })} />
              <Label>可作为 sub-agent</Label>
            </div>
          </div>
          <div className="space-y-1">
            <Label>允许的工具</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1 max-h-60 overflow-y-auto rounded-md border p-2">
              {tools.map((t) => {
                const on = selectedTools.includes(t.name)
                return (
                  <button
                    type="button"
                    key={t.name}
                    onClick={() => setSelectedTools(on ? selectedTools.filter((x) => x !== t.name) : [...selectedTools, t.name])}
                    className={`text-left text-xs rounded px-2 py-1 border ${on ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                    title={t.description}
                  >
                    <div className="font-medium">{t.name}</div>
                    <div className="text-[10px] opacity-80">{t.danger}</div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!a.name || !a.system_prompt || create.isPending}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
