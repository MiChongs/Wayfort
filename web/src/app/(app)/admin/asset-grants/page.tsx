"use client"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileLock2, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { grantService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import type { AssetGrant } from "@/lib/api/types"

export default function AssetGrantsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "grants"], queryFn: grantService.list })
  const remove = useMutation({ mutationFn: (id: number) => grantService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "grants"] }) })
  const cols: Column<AssetGrant>[] = [
    { header: "受授权方", cell: (g) => <Badge variant="outline">{g.grantee_type}#{g.grantee_id}</Badge> },
    { header: "目标", cell: (g) => <Badge variant="outline">{g.subject_type}#{g.subject_id}</Badge> },
    { header: "动作", cell: (g) => <span className="font-mono text-xs">{g.actions}</span> },
    { header: "来源", cell: (g) => g.source || "manual" },
    { header: "操作", className: "text-right", cell: (g) => <Button variant="ghost" size="icon" onClick={() => confirm("确认删除？") && remove.mutate(g.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button> },
  ]
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><FileLock2 className="w-5 h-5" /> 资产授权</h1>
        <CreateGrant onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "grants"] })} />
      </div>
      <DataTable columns={cols} rows={list.data?.grants} loading={list.isLoading} />
    </div>
  )
}

function CreateGrant({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [g, setG] = React.useState<Partial<AssetGrant>>({ grantee_type: "user", grantee_id: 0, subject_type: "node", subject_id: 0, actions: "connect" })
  const create = useMutation({ mutationFn: () => grantService.create(g), onSuccess: () => { setOpen(false); onCreated() } })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建授权</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新建资产授权</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>受授权方类型</Label>
              <Select value={g.grantee_type} onValueChange={(v) => setG({ ...g, grantee_type: v as AssetGrant["grantee_type"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="role">role</SelectItem>
                  <SelectItem value="group">group</SelectItem>
                  <SelectItem value="department">department</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>受授权方 ID</Label><Input type="number" value={g.grantee_id || 0} onChange={(e) => setG({ ...g, grantee_id: Number(e.target.value) })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>目标类型</Label>
              <Select value={g.subject_type} onValueChange={(v) => setG({ ...g, subject_type: v as AssetGrant["subject_type"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="node">node</SelectItem>
                  <SelectItem value="group">asset group</SelectItem>
                  <SelectItem value="tag">tag</SelectItem>
                  <SelectItem value="all">all</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>目标 ID（all 时填 0）</Label><Input type="number" value={g.subject_id || 0} onChange={(e) => setG({ ...g, subject_id: Number(e.target.value) })} /></div>
          </div>
          <div className="space-y-1"><Label>动作（逗号分隔）</Label><Input value={g.actions || ""} onChange={(e) => setG({ ...g, actions: e.target.value })} placeholder="connect,sftp_read,sftp_write" /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={() => create.mutate()} disabled={!g.grantee_id}>创建</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
