"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
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
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import { aiAgentService, aiProviderService } from "@/lib/api/services"
import { AgentAvatar } from "@/components/ai/agent-avatar"
import { IconPicker } from "@/components/icons/icon-picker"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import type { AIAgent, AIProvider, AITool, PermissionMode } from "@/lib/api/types"
import { confirmDialog } from "@/components/common/confirm-dialog"

function parseList(s: string): string[] {
  if (!s) return []
  try { return JSON.parse(s) as string[] } catch { return s.split(",").filter(Boolean) }
}

export default function AIAgentsPage() {
  const qc = useQueryClient()
  const me = useCurrentUser()
  const list = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })
  const providers = useQuery({ queryKey: ["ai", "providers"], queryFn: aiProviderService.list })
  const tools = useQuery({ queryKey: ["ai", "tools"], queryFn: aiAgentService.tools })
  const remove = useMutation({
    mutationFn: (id: number) => aiAgentService.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ai", "agents"] }); toast.success("已删除") },
  })

  const [editing, setEditing] = React.useState<AIAgent | null>(null)

  const cols: Column<AIAgent>[] = [
    { header: "名称", cell: (a) => (
      <button className="flex items-center gap-2 text-left font-medium hover:underline" onClick={() => setEditing(a)}>
        <AgentAvatar agent={a} size="sm" />
        {a.name}
      </button>
    ) },
    { header: "范围", cell: (a) => a.scope === "global" ? <Badge variant="success">global</Badge> : <Badge variant="outline">personal</Badge> },
    { header: "模型", cell: (a) => a.default_model || "—" },
    { header: "权限模式", cell: (a) => <Badge variant="secondary">{a.permission_mode}</Badge> },
    { header: "工具", cell: (a) => <span className="text-xs text-muted-foreground">{parseList(a.allowed_tools).length} 个</span> },
    { header: "Sub-agent", cell: (a) => a.is_sub_agent ? <Badge variant="outline">yes</Badge> : "—" },
    {
      header: "操作", className: "text-right",
      cell: (a) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" title="编辑" onClick={() => setEditing(a)}>
            <Pencil className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost" size="icon" title="删除"
            onClick={async () => {
              const ok = await confirmDialog({ title: `删除 ${a.name}？`, destructive: true })
              if (ok) remove.mutate(a.id)
            }}
          >
            <Trash2 className="w-4 h-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
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
      <DataTable columns={cols} rows={list.data?.agents} loading={list.isLoading} />
      {editing && (
        <EditAgentSheet
          agent={editing}
          providers={providers.data?.providers || []}
          tools={tools.data?.tools || []}
          canBeGlobal={!!me?.adm}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["ai", "agents"] }) }}
        />
      )}
    </div>
  )
}

function CreateDialog({
  providers, tools, canBeGlobal, onCreated,
}: {
  providers: AIProvider[]
  tools: AITool[]
  canBeGlobal: boolean
  onCreated: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [a, setA] = React.useState<Partial<AIAgent>>({
    name: "", description: "", scope: "personal", system_prompt: "",
    default_model: "", permission_mode: "normal", max_iterations: 20,
    is_sub_agent: false, allowed_tools: "[]", enabled: true,
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
        <AgentFormFields
          a={a} setA={setA}
          selectedTools={selectedTools} setSelectedTools={setSelectedTools}
          tools={tools} providers={providers} canBeGlobal={canBeGlobal}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!a.name || !a.system_prompt || create.isPending}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditAgentSheet({
  agent, providers, tools, canBeGlobal, onClose, onSaved,
}: {
  agent: AIAgent
  providers: AIProvider[]
  tools: AITool[]
  canBeGlobal: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [a, setA] = React.useState<Partial<AIAgent>>({ ...agent })
  const [selectedTools, setSelectedTools] = React.useState<string[]>(parseList(agent.allowed_tools))
  const save = useMutation({
    mutationFn: () => aiAgentService.update(agent.id, { ...a, allowed_tools: JSON.stringify(selectedTools) }),
    onSuccess: () => { toast.success("已保存"); onSaved() },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Pencil className="w-4 h-4" /> 编辑 Agent · {agent.name}
          </SheetTitle>
          <SheetDescription>修改 prompt、可用工具和默认模型；保存后立即对所有未来对话生效。</SheetDescription>
        </SheetHeader>
        <AgentFormFields
          a={a} setA={setA}
          selectedTools={selectedTools} setSelectedTools={setSelectedTools}
          tools={tools} providers={providers} canBeGlobal={canBeGlobal}
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>保存</Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function AgentFormFields({
  a, setA, selectedTools, setSelectedTools, tools, providers, canBeGlobal,
}: {
  a: Partial<AIAgent>
  setA: (a: Partial<AIAgent>) => void
  selectedTools: string[]
  setSelectedTools: (t: string[]) => void
  tools: AITool[]
  providers: AIProvider[]
  canBeGlobal: boolean
}) {
  const grouped = React.useMemo(() => {
    const map = new Map<string, AITool[]>()
    for (const t of tools) {
      const cat = t.danger
      const arr = map.get(cat) || []
      arr.push(t); map.set(cat, arr)
    }
    return map
  }, [tools])
  return (
    <div className="space-y-3 mt-2 max-h-[65vh] overflow-y-auto pr-1">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <AgentAvatar agent={{ name: a.name || "", icon: a.icon }} />
        <div className="flex-1 space-y-1">
          <Label>头像图标</Label>
          <IconPicker
            value={a.icon || ""}
            onChange={(t) => setA({ ...a, icon: t })}
            placeholder="默认首字母头像"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1"><Label>名称 *</Label><Input value={a.name || ""} onChange={(e) => setA({ ...a, name: e.target.value })} /></div>
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
        <Label>System Prompt *</Label>
        <Textarea
          rows={8}
          value={a.system_prompt || ""}
          onChange={(e) => setA({ ...a, system_prompt: e.target.value })}
          placeholder={`你是资深 SRE 助手。\n- 调用工具前先用 list_nodes 确认目标存在\n- 写操作执行前用一句话说明你将要做什么\n- 任何不确定的事项都先用 ssh_exec_readonly 查证`}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>默认提供商</Label>
          <Select value={a.default_provider_id ? String(a.default_provider_id) : ""} onValueChange={(v) => setA({ ...a, default_provider_id: Number(v) })}>
            <SelectTrigger><SelectValue placeholder="可选" /></SelectTrigger>
            <SelectContent>
              {providers.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.display_name || p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>默认模型</Label>
          <Input value={a.default_model || ""} onChange={(e) => setA({ ...a, default_model: e.target.value })} placeholder="如 gpt-4o-mini" />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
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
        <div className="space-y-1">
          <Label>最大迭代</Label>
          <Input type="number" value={a.max_iterations || 20} onChange={(e) => setA({ ...a, max_iterations: Number(e.target.value) })} />
        </div>
        <div className="space-y-1">
          <Label>Temperature</Label>
          <Input type="number" step="0.1" value={a.temperature ?? 0} onChange={(e) => setA({ ...a, temperature: Number(e.target.value) })} />
        </div>
        <div className="space-y-1">
          <Label>Top P</Label>
          <Input type="number" step="0.05" value={a.top_p ?? 0} onChange={(e) => setA({ ...a, top_p: Number(e.target.value) })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 pt-1">
        <div className="flex items-center gap-2">
          <Switch checked={!!a.is_sub_agent} onCheckedChange={(v) => setA({ ...a, is_sub_agent: v })} />
          <Label>可作为 sub-agent 被调用</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={a.enabled ?? true} onCheckedChange={(v) => setA({ ...a, enabled: v })} />
          <Label>启用</Label>
        </div>
      </div>
      {a.is_sub_agent && (
        <div className="space-y-1">
          <Label>调用提示</Label>
          <Input
            value={a.invocation_hint || ""}
            onChange={(e) => setA({ ...a, invocation_hint: e.target.value })}
            placeholder="主 agent 看到这条提示，决定何时通过 call_subagent 调用我"
          />
        </div>
      )}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label>允许的工具（{selectedTools.length} 个）</Label>
          <div className="flex gap-1">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setSelectedTools(tools.map((t) => t.name))}
            >全选</button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setSelectedTools([])}
            >清空</button>
          </div>
        </div>
        <div className="rounded-md border max-h-72 overflow-y-auto divide-y">
          {Array.from(grouped.entries()).map(([cat, items]) => (
            <div key={cat} className="p-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                {cat === "low" ? "Low（无需确认）" : cat === "medium" ? "Medium" : "High（normal 模式需确认）"}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                {items.map((t) => {
                  const on = selectedTools.includes(t.name)
                  return (
                    <button
                      type="button"
                      key={t.name}
                      onClick={() => setSelectedTools(on ? selectedTools.filter((x) => x !== t.name) : [...selectedTools, t.name])}
                      className={`text-left text-xs rounded px-2 py-1 border ${on ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                      title={t.description}
                    >
                      <div className="font-mono text-xs flex items-center gap-1">
                        {t.name}
                        {t.required_perm && <Badge variant="outline" className="text-[9px]">需 {t.required_perm}</Badge>}
                      </div>
                      <div className="text-[10px] opacity-80 truncate">{t.description}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
