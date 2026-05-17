"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { credentialService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import type { Credential } from "@/lib/api/types"
import { Badge } from "@/components/ui/badge"

export default function CredentialsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["admin", "credentials"], queryFn: credentialService.list })
  const remove = useMutation({ mutationFn: (id: number) => credentialService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "credentials"] }) })
  const columns: Column<Credential>[] = [
    { header: "名称", cell: (c) => <span className="font-medium">{c.name}</span> },
    { header: "类型", cell: (c) => <Badge variant="secondary">{c.kind}</Badge> },
    { header: "用户名", cell: (c) => c.username || "—" },
    {
      header: "操作", className: "text-right",
      cell: (c) => (
        <Button variant="ghost" size="icon" onClick={() => confirm("确认删除？") && remove.mutate(c.id)}>
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <KeyRound className="w-5 h-5" /> 凭据
        </h1>
        <CreateDialog onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "credentials"] })} />
      </div>
      <DataTable columns={columns} rows={q.data?.credentials} loading={q.isLoading} />
    </div>
  )
}

function CreateDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [c, setC] = React.useState({ name: "", kind: "password", username: "", secret: "", passphrase: "" })
  const create = useMutation({
    mutationFn: () => credentialService.create(c),
    onSuccess: () => { setOpen(false); onCreated(); toast.success("已创建") },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新增凭据</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新增凭据</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>名称</Label><Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></div>
          <div className="space-y-1">
            <Label>类型</Label>
            <Select value={c.kind} onValueChange={(v) => setC({ ...c, kind: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="password">密码</SelectItem>
                <SelectItem value="private_key">私钥</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label>用户名</Label><Input value={c.username} onChange={(e) => setC({ ...c, username: e.target.value })} /></div>
          <div className="space-y-1">
            <Label>{c.kind === "password" ? "密码" : "私钥（PEM）"}</Label>
            <Textarea value={c.secret} onChange={(e) => setC({ ...c, secret: e.target.value })} rows={c.kind === "private_key" ? 6 : 2} />
          </div>
          {c.kind === "private_key" && (
            <div className="space-y-1"><Label>私钥密码（可选）</Label><Input type="password" value={c.passphrase} onChange={(e) => setC({ ...c, passphrase: e.target.value })} /></div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!c.name || !c.secret || create.isPending}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
