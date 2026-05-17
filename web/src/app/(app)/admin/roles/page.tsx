"use client"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { roleService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import type { Permission, Role } from "@/lib/api/types"

export default function RolesPage() {
  const qc = useQueryClient()
  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: roleService.list })
  const perms = useQuery({ queryKey: ["admin", "perms"], queryFn: roleService.permissions })
  const remove = useMutation({ mutationFn: (id: number) => roleService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "roles"] }) })

  const cols: Column<Role>[] = [
    { header: "名称", cell: (r) => <span className="font-medium">{r.name}</span> },
    { header: "类型", cell: (r) => r.is_system ? <Badge variant="secondary">内置</Badge> : <Badge variant="outline">自定义</Badge> },
    { header: "权限点", cell: (r) => <span className="text-xs text-muted-foreground">{r.permissions?.length ?? 0} 个</span> },
    {
      header: "操作", className: "text-right",
      cell: (r) => !r.is_system && (
        <Button variant="ghost" size="icon" onClick={() => confirm("确认删除？") && remove.mutate(r.id)}>
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      ),
    },
  ]
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><ShieldCheck className="w-5 h-5" /> 角色与权限</h1>
        <CreateRole perms={perms.data?.permissions || []} onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "roles"] })} />
      </div>
      <DataTable columns={cols} rows={roles.data?.roles} loading={roles.isLoading} />
      <PermissionList perms={perms.data?.permissions || []} />
    </div>
  )
}

function CreateRole({ perms, onCreated }: { perms: Permission[]; onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [desc, setDesc] = React.useState("")
  const [chosen, setChosen] = React.useState<string[]>([])
  const create = useMutation({
    mutationFn: () => roleService.create({ name, description: desc, permissions: chosen }),
    onSuccess: () => { setOpen(false); setName(""); setDesc(""); setChosen([]); onCreated(); toast.success("已创建") },
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建角色</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>新建角色</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="space-y-1"><Label>描述</Label><Input value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
          </div>
          <div className="space-y-1">
            <Label>权限</Label>
            <div className="max-h-60 overflow-y-auto rounded-md border p-2 grid grid-cols-2 md:grid-cols-3 gap-1">
              {perms.map((p) => {
                const on = chosen.includes(p.code)
                return (
                  <button
                    type="button" key={p.code}
                    onClick={() => setChosen(on ? chosen.filter((x) => x !== p.code) : [...chosen, p.code])}
                    className={`text-left text-xs rounded px-2 py-1 border ${on ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                    title={p.description}
                  >
                    {p.code}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!name || create.isPending}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PermissionList({ perms }: { perms: Permission[] }) {
  if (perms.length === 0) return null
  const byCat = new Map<string, Permission[]>()
  for (const p of perms) {
    const k = p.category || "other"
    const arr = byCat.get(k) || []
    arr.push(p); byCat.set(k, arr)
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {Array.from(byCat.entries()).map(([cat, items]) => (
        <div key={cat} className="rounded-md border p-3">
          <div className="text-xs uppercase text-muted-foreground mb-2">{cat}</div>
          <ul className="space-y-1">
            {items.map((p) => <li key={p.code} className="text-sm"><code className="font-mono text-xs">{p.code}</code> — {p.description}</li>)}
          </ul>
        </div>
      ))}
    </div>
  )
}
