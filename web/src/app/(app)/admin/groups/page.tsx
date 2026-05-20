"use client"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { groupService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import type { UserGroup } from "@/lib/api/types"

export default function GroupsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "groups"], queryFn: groupService.list })
  const remove = useMutation({ mutationFn: (id: number) => groupService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "groups"] }) })
  const cols: Column<UserGroup>[] = [
    { header: "名称", cell: (g) => <span className="font-medium">{g.name}</span> },
    { header: "描述", cell: (g) => g.description || "—" },
    { header: "操作", className: "text-right", cell: (g) => <ConfirmDeleteIconButton title={`删除用户组 “${g.name}”？`} description="组成员关系会被解除,但用户账号本身保留。" loading={remove.isPending} onConfirm={() => remove.mutate(g.id)} /> },
  ]
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Users className="w-5 h-5" /> 用户组</h1>
        <CreateGroup onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "groups"] })} />
      </div>
      <DataTable columns={cols} rows={list.data?.groups} loading={list.isLoading} />
    </div>
  )
}

function CreateGroup({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [g, setG] = React.useState({ name: "", description: "" })
  const create = useMutation({
    mutationFn: () => groupService.create(g),
    onSuccess: () => { setOpen(false); setG({ name: "", description: "" }); onCreated() },
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新建用户组</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>名称</Label><Input value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} /></div>
          <div className="space-y-1"><Label>描述</Label><Input value={g.description} onChange={(e) => setG({ ...g, description: e.target.value })} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={() => create.mutate()} disabled={!g.name}>创建</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
