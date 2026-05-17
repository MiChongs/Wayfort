"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LockOpen, LogOut, Plus, RotateCw, Trash2, Users } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { roleService, userService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import type { Role, User } from "@/lib/api/types"
import { fullTime } from "@/lib/format"

export default function UsersAdminPage() {
  const qc = useQueryClient()
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => userService.list() })
  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: roleService.list })

  const remove = useMutation({
    mutationFn: (id: number) => userService.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  })
  const unlock = useMutation({ mutationFn: (id: number) => userService.unlock(id), onSuccess: () => toast.success("已解锁") })
  const force = useMutation({ mutationFn: (id: number) => userService.forceLogout(id), onSuccess: () => toast.success("已强制下线") })

  const columns: Column<User>[] = [
    { header: "用户名", cell: (u) => <span className="font-medium">{u.username}</span> },
    { header: "显示名", cell: (u) => u.display_name || "—" },
    { header: "邮箱", cell: (u) => u.email || "—" },
    { header: "状态", cell: (u) => (
      <div className="flex gap-1">
        {u.is_admin && <Badge variant="secondary">admin</Badge>}
        {u.disabled && <Badge variant="destructive">disabled</Badge>}
        {u.mfa_enforced && <Badge variant="outline">MFA 强制</Badge>}
        {u.passkey_only && <Badge variant="outline">Passkey-only</Badge>}
      </div>
    ) },
    { header: "最近登录", cell: (u) => <span className="text-xs text-muted-foreground">{u.last_login_at ? fullTime(u.last_login_at) : "—"}</span> },
    {
      header: "操作",
      className: "text-right",
      cell: (u) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" title="解锁" onClick={() => unlock.mutate(u.id)}>
            <LockOpen className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" title="强制下线" onClick={() => force.mutate(u.id)}>
            <LogOut className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" title="删除" onClick={() => confirm("确认删除？") && remove.mutate(u.id)}>
            <Trash2 className="w-4 h-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Users className="w-5 h-5" /> 用户
        </h1>
        <CreateUserDialog roles={roles.data?.roles || []} onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "users"] })} />
      </div>
      <DataTable columns={columns} rows={users.data?.users} loading={users.isLoading} />
    </div>
  )
}

function CreateUserDialog({ roles, onCreated }: { roles: Role[]; onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [u, setU] = React.useState({ username: "", password: "", display_name: "", email: "", is_admin: false })
  const [roleIds, setRoleIds] = React.useState<number[]>([])
  const create = useMutation({
    mutationFn: async () => {
      const created = await userService.create(u as never)
      if (roleIds.length > 0) await userService.replaceRoles(created.id, roleIds)
    },
    onSuccess: () => {
      setOpen(false); setU({ username: "", password: "", display_name: "", email: "", is_admin: false }); setRoleIds([])
      onCreated(); toast.success("已创建用户")
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="w-4 h-4" /> 新建用户</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新建用户</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>用户名</Label><Input value={u.username} onChange={(e) => setU({ ...u, username: e.target.value })} /></div>
          <div className="space-y-1"><Label>密码</Label><Input type="password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>显示名</Label><Input value={u.display_name} onChange={(e) => setU({ ...u, display_name: e.target.value })} /></div>
            <div className="space-y-1"><Label>邮箱</Label><Input value={u.email} onChange={(e) => setU({ ...u, email: e.target.value })} /></div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Switch checked={u.is_admin} onCheckedChange={(v) => setU({ ...u, is_admin: v })} />
            <Label>管理员</Label>
          </div>
          <div className="space-y-1">
            <Label>角色</Label>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => {
                const on = roleIds.includes(r.id)
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setRoleIds(on ? roleIds.filter((x) => x !== r.id) : [...roleIds, r.id])}
                    className={`px-2 py-1 rounded border text-xs ${on ? "bg-primary text-primary-foreground" : ""}`}
                  >
                    {r.name}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!u.username || !u.password || create.isPending}>
            <RotateCw className="w-4 h-4" /> 创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
