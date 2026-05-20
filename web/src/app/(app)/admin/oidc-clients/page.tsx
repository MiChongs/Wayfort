"use client"
import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { oidcService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import type { OIDCClient } from "@/lib/api/types"

export default function OIDCClientsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "oidc"], queryFn: oidcService.list })
  const remove = useMutation({ mutationFn: (id: number) => oidcService.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "oidc"] }) })
  const cols: Column<OIDCClient>[] = [
    { header: "名称", cell: (c) => <span className="font-medium">{c.display_name || c.name}</span> },
    { header: "Issuer", cell: (c) => <code className="font-mono text-xs">{c.issuer}</code> },
    { header: "Client ID", cell: (c) => <code className="font-mono text-xs">{c.client_id}</code> },
    { header: "状态", cell: (c) => c.enabled ? <Badge variant="success">enabled</Badge> : <Badge variant="outline">disabled</Badge> },
    { header: "操作", className: "text-right", cell: (c) => <ConfirmDeleteIconButton title={`删除 OIDC 客户端 “${c.display_name || c.name}”？`} description="已用此客户端登录的用户在 access token 过期后无法刷新。" loading={remove.isPending} onConfirm={() => remove.mutate(c.id)} /> },
  ]
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><ShieldCheck className="w-5 h-5" /> OIDC 客户端</h1>
        <CreateOIDC onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "oidc"] })} />
      </div>
      <DataTable columns={cols} rows={list.data?.oidc_clients} loading={list.isLoading} />
    </div>
  )
}

function CreateOIDC({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [c, setC] = React.useState<Partial<OIDCClient> & { client_secret?: string }>({
    name: "", display_name: "", issuer: "", client_id: "", client_secret: "",
    redirect_uri: "", scopes: "openid email profile", enabled: true, auto_create_user: false,
  })
  const create = useMutation({ mutationFn: () => oidcService.create(c), onSuccess: () => { setOpen(false); onCreated() } })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>新建 OIDC 客户端</DialogTitle></DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>名称（slug）</Label><Input value={c.name || ""} onChange={(e) => setC({ ...c, name: e.target.value })} /></div>
            <div className="space-y-1"><Label>显示名</Label><Input value={c.display_name || ""} onChange={(e) => setC({ ...c, display_name: e.target.value })} /></div>
          </div>
          <div className="space-y-1"><Label>Issuer</Label><Input value={c.issuer || ""} onChange={(e) => setC({ ...c, issuer: e.target.value })} placeholder="https://keycloak.local/realms/main" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Client ID</Label><Input value={c.client_id || ""} onChange={(e) => setC({ ...c, client_id: e.target.value })} /></div>
            <div className="space-y-1"><Label>Client Secret</Label><Input type="password" value={c.client_secret || ""} onChange={(e) => setC({ ...c, client_secret: e.target.value })} /></div>
          </div>
          <div className="space-y-1"><Label>Redirect URI</Label><Input value={c.redirect_uri || ""} onChange={(e) => setC({ ...c, redirect_uri: e.target.value })} placeholder="http://localhost:3000/api/proxy/api/v1/auth/oidc/keycloak/callback" /></div>
          <div className="space-y-1"><Label>Scopes</Label><Input value={c.scopes || ""} onChange={(e) => setC({ ...c, scopes: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Username claim</Label><Input value={c.username_claim || ""} onChange={(e) => setC({ ...c, username_claim: e.target.value })} placeholder="preferred_username" /></div>
            <div className="space-y-1"><Label>Email claim</Label><Input value={c.email_claim || ""} onChange={(e) => setC({ ...c, email_claim: e.target.value })} placeholder="email" /></div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2"><Switch checked={!!c.enabled} onCheckedChange={(v) => setC({ ...c, enabled: v })} /><Label>启用</Label></div>
            <div className="flex items-center gap-2"><Switch checked={!!c.auto_create_user} onCheckedChange={(v) => setC({ ...c, auto_create_user: v })} /><Label>自动创建本地用户</Label></div>
          </div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={() => create.mutate()} disabled={!c.name || !c.issuer || !c.client_id || !c.client_secret}>创建</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
