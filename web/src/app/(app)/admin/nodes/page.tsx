"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Server, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { credentialService, nodeService, proxyService } from "@/lib/api/services"
import type { Node, NodeProtocol } from "@/lib/api/types"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"

export default function AdminNodesPage() {
  const qc = useQueryClient()
  const nodes = useQuery({ queryKey: ["admin", "nodes"], queryFn: nodeService.list })
  const creds = useQuery({ queryKey: ["admin", "credentials"], queryFn: credentialService.list })
  const proxies = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })

  const remove = useMutation({ mutationFn: (id: number) => nodeService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "nodes"] }) })

  const columns: Column<Node>[] = [
    { header: "名称", cell: (n) => <span className="font-medium">{n.name}</span> },
    { header: "协议", cell: (n) => <Badge variant="secondary">{n.protocol}</Badge> },
    { header: "地址", cell: (n) => `${n.host}:${n.port}` },
    { header: "用户", cell: (n) => n.username || "—" },
    { header: "代理链", cell: (n) => n.proxy_chain || "直连" },
    {
      header: "操作",
      className: "text-right",
      cell: (n) => (
        <Button variant="ghost" size="icon" onClick={() => confirm("确认删除？") && remove.mutate(n.id)}>
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Server className="w-5 h-5" /> 节点 - 资产
        </h1>
        <CreateNodeDialog
          credentials={creds.data?.credentials || []}
          proxies={proxies.data?.proxies || []}
          onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "nodes"] })}
        />
      </div>
      <DataTable columns={columns} rows={nodes.data?.nodes} loading={nodes.isLoading} />
    </div>
  )
}

function CreateNodeDialog({
  credentials, proxies, onCreated,
}: {
  credentials: { id: number; name: string }[]
  proxies: { id: number; name: string }[]
  onCreated: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<Partial<Node> & { credential_id?: number }>({
    protocol: "ssh", port: 22, name: "", host: "", username: "",
  })
  const create = useMutation({
    mutationFn: () => nodeService.create(draft as Node),
    onSuccess: () => { setOpen(false); onCreated(); toast.success("已创建节点") },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新增节点</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>新增节点</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>名称</Label><Input value={draft.name || ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            <div className="space-y-1">
              <Label>协议</Label>
              <Select value={draft.protocol} onValueChange={(v) => setDraft({ ...draft, protocol: v as NodeProtocol, port: defaultPort(v as NodeProtocol) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(["ssh", "telnet", "rdp", "vnc", "mysql", "postgres", "redis", "mongo", "tcp"] as NodeProtocol[]).map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1 col-span-2"><Label>主机</Label><Input value={draft.host || ""} onChange={(e) => setDraft({ ...draft, host: e.target.value })} /></div>
            <div className="space-y-1"><Label>端口</Label><Input type="number" value={draft.port || ""} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>用户名（节点登录）</Label><Input value={draft.username || ""} onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></div>
            <div className="space-y-1">
              <Label>凭据</Label>
              <Select value={draft.credential_id ? String(draft.credential_id) : ""} onValueChange={(v) => setDraft({ ...draft, credential_id: Number(v) })}>
                <SelectTrigger><SelectValue placeholder="选择凭据" /></SelectTrigger>
                <SelectContent>{credentials.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label>代理链（逗号分隔的 proxy id）</Label>
            <Input placeholder="例如 3,1" value={draft.proxy_chain || ""} onChange={(e) => setDraft({ ...draft, proxy_chain: e.target.value })} />
            <div className="text-xs text-muted-foreground">可用代理：{proxies.map((p) => `${p.id}=${p.name}`).join(" / ") || "无"}</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>区域</Label><Input value={draft.region || ""} onChange={(e) => setDraft({ ...draft, region: e.target.value })} /></div>
            <div className="space-y-1"><Label>标签（逗号分隔）</Label><Input value={draft.tags || ""} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} /></div>
          </div>
          <div className="space-y-1">
            <Label>协议参数 JSON（可选）</Label>
            <Textarea
              placeholder='RDP 示例：{"security":"any","domain":"WORKGROUP"} · VNC 示例：{}'
              value={draft.proto_options || ""}
              onChange={(e) => setDraft({ ...draft, proto_options: e.target.value })}
              rows={3}
            />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              RDP / VNC 默认 <code className="font-mono">ignore-cert: true</code>
              （自签证书直连）。需强制校验填
              <code className="font-mono">"ignore-cert":"false"</code>。其它支持的键：
              <code className="font-mono">security</code>（any/nla/tls/rdp）、
              <code className="font-mono">domain</code>（RDP 域）。
            </p>
          </div>
          <div className="space-y-1"><Label>描述</Label><Textarea value={draft.description || ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!draft.name || !draft.host || !draft.credential_id || create.isPending}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function defaultPort(p: NodeProtocol): number {
  return { ssh: 22, telnet: 23, rdp: 3389, vnc: 5900, mysql: 3306, postgres: 5432, redis: 6379, mongo: 27017, tcp: 0 }[p] ?? 0
}
