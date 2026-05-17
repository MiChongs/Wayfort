"use client"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Network, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { departmentService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import type { Department } from "@/lib/api/types"

export default function DepartmentsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "depts"], queryFn: departmentService.list })
  const remove = useMutation({ mutationFn: (id: number) => departmentService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "depts"] }) })
  const cols: Column<Department>[] = [
    { header: "名称", cell: (d) => <span style={{ paddingLeft: indent(d.path) }}><span className="font-medium">{d.name}</span></span> },
    { header: "路径", cell: (d) => <code className="text-xs font-mono">{d.path}</code> },
    { header: "操作", className: "text-right", cell: (d) => (
      <Button variant="ghost" size="icon" onClick={() => confirm("确认删除？") && remove.mutate(d.id)}>
        <Trash2 className="w-4 h-4 text-destructive" />
      </Button>
    )},
  ]
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Network className="w-5 h-5" /> 部门</h1>
        <CreateDept depts={list.data?.departments || []} onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "depts"] })} />
      </div>
      <DataTable columns={cols} rows={list.data?.departments} loading={list.isLoading} />
    </div>
  )
}

function indent(path: string): number { return Math.max(0, path.split("/").length - 1) * 16 }

function CreateDept({ depts, onCreated }: { depts: Department[]; onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [parentId, setParentId] = React.useState<number | null>(null)
  const create = useMutation({
    mutationFn: () => departmentService.create({ name, parent_id: parentId ?? null } as Department),
    onSuccess: () => { setOpen(false); setName(""); setParentId(null); onCreated() },
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建部门</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新建部门</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1">
            <Label>父部门（可选）</Label>
            <select className="h-9 w-full border rounded-md bg-background px-2" value={parentId ?? ""} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">无</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.path} {d.name}</option>)}
            </select>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={() => create.mutate()} disabled={!name}>创建</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
