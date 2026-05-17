"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Plus, TestTube2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { aiProviderService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import type { AIProvider, ProviderKind } from "@/lib/api/types"

export default function AIProvidersPage() {
  const qc = useQueryClient()
  const me = useCurrentUser()
  const list = useQuery({ queryKey: ["ai", "providers"], queryFn: aiProviderService.list })
  const remove = useMutation({ mutationFn: (id: number) => aiProviderService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "providers"] }) })
  const test = useMutation({
    mutationFn: (id: number) => aiProviderService.test(id),
    onSuccess: () => toast.success("拨测成功"),
    onError: (e: unknown) => toast.error("拨测失败", { description: (e as Error).message }),
  })

  const columns: Column<AIProvider>[] = [
    { header: "名称", cell: (p) => <span className="font-medium">{p.display_name || p.name}</span> },
    { header: "类型", cell: (p) => <Badge variant="secondary">{p.kind}</Badge> },
    { header: "范围", cell: (p) => p.is_global ? <Badge variant="success">全局</Badge> : <Badge variant="outline">个人</Badge> },
    { header: "默认模型", cell: (p) => p.default_model || "—" },
    { header: "BaseURL", cell: (p) => <span className="text-xs text-muted-foreground">{p.base_url || "默认"}</span> },
    { header: "Key", cell: (p) => <span className="font-mono text-xs">…{p.api_key_last4 || "????"}</span> },
    { header: "状态", cell: (p) => p.enabled ? <Badge variant="success">enabled</Badge> : <Badge variant="outline">disabled</Badge> },
    {
      header: "操作", className: "text-right",
      cell: (p) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" title="拨测" onClick={() => test.mutate(p.id)}>
            <TestTube2 className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" title="删除" onClick={() => confirm("确认删除？") && remove.mutate(p.id)}>
            <Trash2 className="w-4 h-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Bot className="w-5 h-5" /> AI 提供商
        </h1>
        <CreateDialog onCreated={() => qc.invalidateQueries({ queryKey: ["ai", "providers"] })} canBeGlobal={!!me?.adm} />
      </div>
      <DataTable columns={columns} rows={list.data?.providers} loading={list.isLoading} />
    </div>
  )
}

function CreateDialog({ onCreated, canBeGlobal }: { onCreated: () => void; canBeGlobal: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [p, setP] = React.useState<Partial<AIProvider> & { api_key: string }>({
    name: "", kind: "openai", display_name: "", base_url: "", default_model: "gpt-4o-mini", is_global: false, api_key: "",
  })
  const create = useMutation({
    mutationFn: () => aiProviderService.create(p as AIProvider & { api_key: string }),
    onSuccess: () => { setOpen(false); onCreated(); toast.success("已创建") },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新增提供商</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新增 AI 提供商</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>名称</Label><Input value={p.name || ""} onChange={(e) => setP({ ...p, name: e.target.value })} /></div>
            <div className="space-y-1"><Label>显示名</Label><Input value={p.display_name || ""} onChange={(e) => setP({ ...p, display_name: e.target.value })} /></div>
          </div>
          <div className="space-y-1">
            <Label>类型</Label>
            <Select value={p.kind} onValueChange={(v) => setP({ ...p, kind: v as ProviderKind })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic Claude</SelectItem>
                <SelectItem value="openai_compatible">OpenAI 兼容（NewAPI / 硅基流动 / DeepSeek / Moonshot / 通义 …）</SelectItem>
                <SelectItem value="gemini">Google Gemini</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>BaseURL（兼容网关填，OpenAI 留空）</Label>
            <Input value={p.base_url || ""} onChange={(e) => setP({ ...p, base_url: e.target.value })} placeholder="https://api.siliconflow.cn/v1" />
          </div>
          <div className="space-y-1"><Label>默认模型</Label><Input value={p.default_model || ""} onChange={(e) => setP({ ...p, default_model: e.target.value })} /></div>
          <div className="space-y-1"><Label>API Key</Label><Input type="password" value={p.api_key} onChange={(e) => setP({ ...p, api_key: e.target.value })} /></div>
          {canBeGlobal && (
            <div className="flex items-center gap-2">
              <Switch checked={!!p.is_global} onCheckedChange={(v) => setP({ ...p, is_global: v })} />
              <Label>全局可见（所有用户）</Label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!p.name || !p.api_key || create.isPending}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
