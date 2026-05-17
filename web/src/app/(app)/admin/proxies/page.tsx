"use client"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Network, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { credentialService, proxyService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import type { Proxy } from "@/lib/api/types"

export default function ProxiesPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })
  const creds = useQuery({ queryKey: ["admin", "credentials"], queryFn: credentialService.list })
  const remove = useMutation({ mutationFn: (id: number) => proxyService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "proxies"] }) })
  const cols: Column<Proxy>[] = [
    { header: "名称", cell: (p) => <span className="font-medium">{p.name}</span> },
    { header: "类型", cell: (p) => <Badge variant="secondary">{p.kind}</Badge> },
    { header: "地址", cell: (p) => p.host ? `${p.host}:${p.port}` : "—" },
    { header: "凭据", cell: (p) => p.credential_id ?? "—" },
    { header: "操作", className: "text-right", cell: (p) => <Button variant="ghost" size="icon" onClick={() => confirm("确认删除？") && remove.mutate(p.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button> },
  ]
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Network className="w-5 h-5" /> 代理</h1>
        <CreateProxy credentials={creds.data?.credentials || []} onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "proxies"] })} />
      </div>
      <DataTable columns={cols} rows={list.data?.proxies} loading={list.isLoading} />
    </div>
  )
}

function CreateProxy({ credentials, onCreated }: { credentials: { id: number; name: string }[]; onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [p, setP] = React.useState<Partial<Proxy> & { credential_id?: number }>({ kind: "socks5", name: "", host: "", port: 1080 })
  const create = useMutation({
    mutationFn: () => proxyService.create(p as Proxy),
    onSuccess: () => { setOpen(false); onCreated() },
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建代理</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新建代理</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>名称</Label><Input value={p.name || ""} onChange={(e) => setP({ ...p, name: e.target.value })} /></div>
            <div className="space-y-1">
              <Label>类型</Label>
              <Select value={p.kind} onValueChange={(v) => setP({ ...p, kind: v as Proxy["kind"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">direct</SelectItem>
                  <SelectItem value="socks5">SOCKS5</SelectItem>
                  <SelectItem value="bastion">SSH bastion</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1 col-span-2"><Label>主机</Label><Input value={p.host || ""} onChange={(e) => setP({ ...p, host: e.target.value })} /></div>
            <div className="space-y-1"><Label>端口</Label><Input type="number" value={p.port || 0} onChange={(e) => setP({ ...p, port: Number(e.target.value) })} /></div>
          </div>
          <div className="space-y-1">
            <Label>凭据（bastion 必填）</Label>
            <Select value={p.credential_id ? String(p.credential_id) : ""} onValueChange={(v) => setP({ ...p, credential_id: Number(v) })}>
              <SelectTrigger><SelectValue placeholder="选择凭据" /></SelectTrigger>
              <SelectContent>{credentials.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={() => create.mutate()} disabled={!p.name}>创建</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
