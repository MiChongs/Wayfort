"use client"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Tag as TagIcon, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { tagService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import type { AssetTag } from "@/lib/api/types"

export default function TagsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "tags"], queryFn: tagService.list })
  const remove = useMutation({ mutationFn: (id: number) => tagService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "tags"] }) })
  const cols: Column<AssetTag>[] = [
    { header: "名称", cell: (t) => <span style={{ color: t.color }} className="font-medium">{t.name}</span> },
    { header: "颜色", cell: (t) => t.color || "—" },
    { header: "操作", className: "text-right", cell: (t) => <Button variant="ghost" size="icon" onClick={() => confirm("确认删除？") && remove.mutate(t.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button> },
  ]
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState(""); const [color, setColor] = React.useState("")
  const create = useMutation({ mutationFn: () => tagService.create({ name, color }), onSuccess: () => { setOpen(false); setName(""); setColor(""); qc.invalidateQueries({ queryKey: ["admin", "tags"] }) } })
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><TagIcon className="w-5 h-5" /> 标签</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>新建标签</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="space-y-1"><Label>颜色 (CSS)</Label><Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="#22c55e" /></div>
            </div>
            <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={() => create.mutate()} disabled={!name}>创建</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <DataTable columns={cols} rows={list.data?.tags} loading={list.isLoading} />
    </div>
  )
}
