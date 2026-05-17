"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronLeft, ChevronRight, History, KeyRound, LockOpen, LogOut, Pencil,
  Plus, Search, ShieldCheck, Trash2, Users,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { departmentService, roleService, userService } from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import type { Department, Role, User } from "@/lib/api/types"
import { fullTime, relTime } from "@/lib/format"
import { confirmDialog } from "@/components/common/confirm-dialog"

const PAGE_SIZE = 50

export default function UsersAdminPage() {
  const qc = useQueryClient()
  const [page, setPage] = React.useState(0)
  const [search, setSearch] = React.useState("")
  const [disabledFilter, setDisabledFilter] = React.useState<"all" | "true" | "false">("all")

  const users = useQuery({
    queryKey: ["admin", "users", search, disabledFilter, page],
    queryFn: () => userService.list({
      search: search || undefined,
      disabled: disabledFilter === "all" ? undefined : disabledFilter,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
  })
  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: roleService.list })
  const depts = useQuery({ queryKey: ["admin", "depts"], queryFn: departmentService.list })

  const remove = useMutation({
    mutationFn: (id: number) => userService.remove(id),
    onSuccess: () => { toast.success("已删除"); qc.invalidateQueries({ queryKey: ["admin", "users"] }) },
  })
  const unlock = useMutation({ mutationFn: (id: number) => userService.unlock(id), onSuccess: () => toast.success("已解锁") })
  const force = useMutation({ mutationFn: (id: number) => userService.forceLogout(id), onSuccess: () => toast.success("已强制下线") })

  const [editing, setEditing] = React.useState<User | null>(null)
  const [reset, setReset] = React.useState<User | null>(null)

  const cols: Column<User>[] = [
    {
      header: "用户名",
      cell: (u) => (
        <button
          className="font-medium hover:underline text-left"
          onClick={() => setEditing(u)}
        >
          {u.username}
        </button>
      ),
    },
    { header: "显示名 / 邮箱", cell: (u) => (
      <div>
        <div>{u.display_name || "—"}</div>
        <div className="text-xs text-muted-foreground">{u.email || ""}</div>
      </div>
    ) },
    { header: "部门", cell: (u) => {
      const d = depts.data?.departments.find((x) => x.id === u.department_id)
      return d ? d.name : "—"
    } },
    { header: "状态", cell: (u) => (
      <div className="flex flex-wrap gap-1">
        {u.is_admin && <Badge variant="secondary">admin</Badge>}
        {u.disabled && <Badge variant="destructive">disabled</Badge>}
        {u.mfa_enforced && <Badge variant="outline">MFA 强制</Badge>}
        {u.passkey_only && <Badge variant="outline">Passkey-only</Badge>}
      </div>
    ) },
    { header: "最近登录", cell: (u) => (
      u.last_login_at ? (
        <div className="text-xs">
          <div>{fullTime(u.last_login_at)}</div>
          <div className="text-muted-foreground">{relTime(u.last_login_at)} · {u.last_login_ip}</div>
        </div>
      ) : <span className="text-xs text-muted-foreground">从未</span>
    ) },
    {
      header: "操作",
      className: "text-right",
      cell: (u) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" title="编辑" onClick={() => setEditing(u)}>
            <Pencil className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" title="重置密码" onClick={() => setReset(u)}>
            <KeyRound className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" title="解锁" onClick={() => unlock.mutate(u.id)}>
            <LockOpen className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="强制下线"
            onClick={async () => {
              const ok = await confirmDialog({
                title: `把 ${u.username} 踢下线？`,
                description: "该用户当前所有 access token 会立即失效。",
              })
              if (ok) force.mutate(u.id)
            }}
          >
            <LogOut className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="删除"
            onClick={async () => {
              const ok = await confirmDialog({
                title: `删除用户 ${u.username}？`,
                description: "用户的会话/角色/MFA/Passkey/收藏等关联数据都会被一并删除。",
                destructive: true,
                confirmLabel: "永久删除",
              })
              if (ok) remove.mutate(u.id)
            }}
          >
            <Trash2 className="w-4 h-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Users className="w-5 h-5" /> 用户管理
        </h1>
        <CreateUserDialog
          roles={roles.data?.roles || []}
          depts={depts.data?.departments || []}
          onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "users"] })}
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative w-72">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} placeholder="搜索 用户名 / 显示名 / 邮箱" className="pl-8" />
        </div>
        <Select value={disabledFilter} onValueChange={(v) => { setDisabledFilter(v as "all" | "true" | "false"); setPage(0) }}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="false">仅启用</SelectItem>
            <SelectItem value="true">仅禁用</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={cols} rows={users.data?.users} loading={users.isLoading} />

      <div className="flex justify-end gap-2 text-sm">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          <ChevronLeft className="w-4 h-4" /> 上一页
        </Button>
        <Button variant="outline" size="sm" disabled={(users.data?.users?.length ?? 0) < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
          下一页 <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {editing && (
        <EditUserSheet
          user={editing}
          roles={roles.data?.roles || []}
          depts={depts.data?.departments || []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["admin", "users"] }) }}
        />
      )}
      {reset && (
        <ResetPasswordDialog
          user={reset}
          onClose={() => setReset(null)}
        />
      )}
    </div>
  )
}

function CreateUserDialog({ roles, depts, onCreated }: {
  roles: Role[]
  depts: Department[]
  onCreated: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [u, setU] = React.useState({
    username: "", password: "", display_name: "", email: "", phone: "",
    is_admin: false, mfa_enforced: false, passkey_only: false,
    department_id: null as number | null,
  })
  const [roleIds, setRoleIds] = React.useState<number[]>([])
  const create = useMutation({
    mutationFn: async () => {
      const created = await userService.create(u as never)
      if (roleIds.length > 0) await userService.replaceRoles(created.id, roleIds)
    },
    onSuccess: () => {
      setOpen(false)
      setU({ username: "", password: "", display_name: "", email: "", phone: "", is_admin: false, mfa_enforced: false, passkey_only: false, department_id: null })
      setRoleIds([])
      onCreated()
      toast.success("已创建用户")
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="w-4 h-4" /> 新建用户</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>新建用户</DialogTitle></DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>用户名 *</Label><Input value={u.username} onChange={(e) => setU({ ...u, username: e.target.value })} /></div>
            <div className="space-y-1"><Label>初始密码 *</Label><Input type="password" value={u.password} onChange={(e) => setU({ ...u, password: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>显示名</Label><Input value={u.display_name} onChange={(e) => setU({ ...u, display_name: e.target.value })} /></div>
            <div className="space-y-1"><Label>邮箱</Label><Input value={u.email} onChange={(e) => setU({ ...u, email: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>电话</Label><Input value={u.phone} onChange={(e) => setU({ ...u, phone: e.target.value })} /></div>
            <div className="space-y-1">
              <Label>部门</Label>
              <select
                className="h-9 w-full border rounded-md bg-background px-2 text-sm"
                value={u.department_id ?? ""}
                onChange={(e) => setU({ ...u, department_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">无</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.path} {d.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 pt-1">
            <FlagSwitch label="管理员" checked={u.is_admin} onChange={(v) => setU({ ...u, is_admin: v })} />
            <FlagSwitch label="强制 MFA" checked={u.mfa_enforced} onChange={(v) => setU({ ...u, mfa_enforced: v })} />
            <FlagSwitch label="仅 Passkey" checked={u.passkey_only} onChange={(v) => setU({ ...u, passkey_only: v })} />
          </div>
          <div className="space-y-1">
            <Label>角色（多选）</Label>
            <RolePicker roles={roles} value={roleIds} onChange={setRoleIds} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!u.username || !u.password || create.isPending}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditUserSheet({ user, roles, depts, onClose, onSaved }: {
  user: User
  roles: Role[]
  depts: Department[]
  onClose: () => void
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = React.useState({ ...user })
  const currentRoles = useQuery({ queryKey: ["admin", "user-roles", user.id], queryFn: () => userService.listRoles(user.id) })
  const [roleIds, setRoleIds] = React.useState<number[]>([])
  React.useEffect(() => {
    if (currentRoles.data?.roles) setRoleIds(currentRoles.data.roles.map((r) => r.id))
  }, [currentRoles.data])

  const save = useMutation({
    mutationFn: async () => {
      await userService.update(user.id, draft)
      await userService.replaceRoles(user.id, roleIds)
    },
    onSuccess: () => { toast.success("已保存"); onSaved() },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  const force = useMutation({ mutationFn: () => userService.forceLogout(user.id), onSuccess: () => toast.success("已强制下线") })
  const unlock = useMutation({ mutationFn: () => userService.unlock(user.id), onSuccess: () => { toast.success("已解锁"); qc.invalidateQueries({ queryKey: ["admin", "users"] }) } })

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Pencil className="w-4 h-4" /> 编辑用户 · {user.username}
          </SheetTitle>
          <SheetDescription>更新基本信息、角色绑定和安全开关。</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 mt-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>显示名</Label><Input value={draft.display_name || ""} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} /></div>
            <div className="space-y-1"><Label>邮箱</Label><Input value={draft.email || ""} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>电话</Label><Input value={draft.phone || ""} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></div>
            <div className="space-y-1">
              <Label>部门</Label>
              <select
                className="h-9 w-full border rounded-md bg-background px-2 text-sm"
                value={draft.department_id ?? ""}
                onChange={(e) => setDraft({ ...draft, department_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">无</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.path} {d.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FlagSwitch label="管理员" checked={!!draft.is_admin} onChange={(v) => setDraft({ ...draft, is_admin: v })} />
            <FlagSwitch label="已禁用" checked={!!draft.disabled} onChange={(v) => setDraft({ ...draft, disabled: v })} />
            <FlagSwitch label="强制 MFA" checked={!!draft.mfa_enforced} onChange={(v) => setDraft({ ...draft, mfa_enforced: v })} />
            <FlagSwitch label="仅 Passkey 登录" checked={!!draft.passkey_only} onChange={(v) => setDraft({ ...draft, passkey_only: v })} />
          </div>
          <div className="space-y-1">
            <Label>角色</Label>
            <RolePicker roles={roles} value={roleIds} onChange={setRoleIds} />
          </div>
          <div className="rounded-md border bg-muted/40 p-3 space-y-2">
            <div className="text-xs font-medium uppercase text-muted-foreground">管理操作</div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => unlock.mutate()}>
                <LockOpen className="w-4 h-4" /> 解锁
              </Button>
              <Button size="sm" variant="outline" onClick={() => force.mutate()}>
                <LogOut className="w-4 h-4" /> 强制下线
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={"/me/login-history" as Parameters<typeof Link>[0]["href"]}>
                  <History className="w-4 h-4" /> 登录历史
                </Link>
              </Button>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              保存
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ResetPasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const [pw, setPw] = React.useState("")
  const reset = useMutation({
    mutationFn: () => userService.resetPassword(user.id, pw),
    onSuccess: () => { toast.success(`已重置 ${user.username} 的密码`); onClose() },
    onError: (e: unknown) => toast.error("重置失败", { description: (e as Error).message }),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-4 h-4" /> 重置 {user.username} 的密码
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label>新密码（≥ 8 位）</Label>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={pw.length < 8 || reset.isPending} onClick={() => reset.mutate()}>重置密码</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FlagSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch checked={checked} onCheckedChange={onChange} />
      <Label className="text-sm">{label}</Label>
    </div>
  )
}

function RolePicker({ roles, value, onChange }: { roles: Role[]; value: number[]; onChange: (v: number[]) => void }) {
  if (roles.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        还没有角色。先到 <Link href={"/admin/roles" as Parameters<typeof Link>[0]["href"]} className="text-primary hover:underline">角色管理</Link> 创建。
      </p>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map((r) => {
        const on = value.includes(r.id)
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== r.id) : [...value, r.id])}
            className={`px-2 py-1 rounded-full border text-xs transition-colors ${on ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"}`}
          >
            {r.is_system ? <ShieldCheck className="w-3 h-3 mr-1 inline" /> : null}
            {r.name}
          </button>
        )
      })}
    </div>
  )
}
