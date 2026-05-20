"use client"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Tags } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { assetGroupService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import type { AssetGroup } from "@/lib/api/types"

export default function AssetGroupsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "asset-groups"], queryFn: assetGroupService.list })
  const remove = useMutation({ mutationFn: (id: number) => assetGroupService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "asset-groups"] }) })
  const cols: Column<AssetGroup>[] = [
    { header: "名称", cell: (g) => <span style={{ paddingLeft: Math.max(0, g.path.split("/").length - 1) * 16 }} className="font-medium">{g.name}</span> },
    { header: "路径", cell: (g) => <code className="text-xs font-mono">{g.path}</code> },
    { header: "操作", className: "text-right", cell: (g) => <ConfirmDeleteIconButton title={`删除资产组 “${g.name}”？`} description="该组下的子节点不会被删除,但会移出当前分组。" loading={remove.isPending} onConfirm={() => remove.mutate(g.id)} /> },
  ]
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Tags className="w-5 h-5" /> 资产组</h1>
        <CreateGroup groups={list.data?.asset_groups || []} onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "asset-groups"] })} />
      </div>
      <DataTable columns={cols} rows={list.data?.asset_groups} loading={list.isLoading} />
    </div>
  )
}

function CreateGroup({ groups, onCreated }: { groups: AssetGroup[]; onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [parentId, setParentId] = React.useState<number | null>(null)
  const create = useMutation({
    mutationFn: () => assetGroupService.create({ name, parent_id: parentId ?? null } as AssetGroup),
    onSuccess: () => { setOpen(false); setName(""); setParentId(null); onCreated() },
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建资产组</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新建资产组</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>名称</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1">
            <Label>父组（可选）</Label>
            <Select value={parentId ? String(parentId) : "_none"} onValueChange={(v) => setParentId(v === "_none" ? null : Number(v))}>
              <SelectTrigger><SelectValue placeholder="选择父组" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">无</SelectItem>
                {groups.map((g) => <SelectItem key={g.id} value={String(g.id)}>{g.path}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={() => create.mutate()} disabled={!name}>创建</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
