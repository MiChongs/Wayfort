"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileLock2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import {
  assetGroupService, departmentService, grantService, groupService, nodeService, roleService, tagService, userService,
} from "@/lib/api/services"
import { DataTable, type Column } from "@/components/common/data-table"
import { Badge } from "@/components/ui/badge"
import type { AssetGrant } from "@/lib/api/types"
import { confirmDialog } from "@/components/common/confirm-dialog"

const ACTIONS = [
  { code: "connect", label: "连接（终端 / 图形 / DB CLI）" },
  { code: "sftp_read", label: "SFTP 读取" },
  { code: "sftp_write", label: "SFTP 写入" },
  { code: "port_forward", label: "端口转发" },
  { code: "upload", label: "文件上传" },
  { code: "download", label: "文件下载" },
  { code: "*", label: "全部动作（管理员级）" },
]

export default function AssetGrantsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "grants"], queryFn: grantService.list })
  const users = useQuery({ queryKey: ["admin", "users", "all"], queryFn: () => userService.list({ limit: 500 }) })
  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: roleService.list })
  const groups = useQuery({ queryKey: ["admin", "groups"], queryFn: groupService.list })
  const depts = useQuery({ queryKey: ["admin", "depts"], queryFn: departmentService.list })
  const nodes = useQuery({ queryKey: ["admin", "nodes"], queryFn: nodeService.list })
  const assetGroups = useQuery({ queryKey: ["admin", "asset-groups"], queryFn: assetGroupService.list })
  const tags = useQuery({ queryKey: ["admin", "tags"], queryFn: tagService.list })

  const remove = useMutation({
    mutationFn: (id: number) => grantService.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin", "grants"] }); toast.success("已删除") },
  })

  function granteeName(g: AssetGrant): string {
    switch (g.grantee_type) {
      case "user": return users.data?.users.find((u) => u.id === g.grantee_id)?.username || `user#${g.grantee_id}`
      case "role": return roles.data?.roles.find((r) => r.id === g.grantee_id)?.name || `role#${g.grantee_id}`
      case "group": return groups.data?.groups.find((x) => x.id === g.grantee_id)?.name || `group#${g.grantee_id}`
      case "department": return depts.data?.departments.find((x) => x.id === g.grantee_id)?.name || `dept#${g.grantee_id}`
    }
  }
  function subjectName(g: AssetGrant): string {
    if (g.subject_type === "all") return "全部资产"
    switch (g.subject_type) {
      case "node": return nodes.data?.nodes.find((n) => n.id === g.subject_id)?.name || `node#${g.subject_id}`
      case "group": return assetGroups.data?.asset_groups.find((x) => x.id === g.subject_id)?.name || `group#${g.subject_id}`
      case "tag": return tags.data?.tags.find((t) => t.id === g.subject_id)?.name || `tag#${g.subject_id}`
    }
    return ""
  }

  const cols: Column<AssetGrant>[] = [
    { header: "受授权方", cell: (g) => (
      <div className="flex items-center gap-2">
        <Badge variant="outline">{g.grantee_type}</Badge>
        <span className="font-medium">{granteeName(g)}</span>
      </div>
    ) },
    { header: "目标资产", cell: (g) => (
      <div className="flex items-center gap-2">
        <Badge variant="outline">{g.subject_type}</Badge>
        <span>{subjectName(g)}</span>
      </div>
    ) },
    { header: "动作", cell: (g) => (
      <div className="flex flex-wrap gap-1">
        {g.actions.split(",").filter(Boolean).map((a) => (
          <Badge key={a} variant={a === "*" ? "secondary" : "outline"} className="text-xs">{a}</Badge>
        ))}
      </div>
    ) },
    {
      header: "操作", className: "text-right",
      cell: (g) => (
        <Button
          variant="ghost" size="icon"
          onClick={async () => {
            const ok = await confirmDialog({ title: "撤销该资产授权？", destructive: true })
            if (ok) remove.mutate(g.id)
          }}
        >
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      ),
    },
  ]

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <FileLock2 className="w-5 h-5" /> 资产授权
        </h1>
        <CreateGrantDialog
          users={users.data?.users.map((u) => ({ id: u.id, name: u.username })) || []}
          roles={roles.data?.roles.map((r) => ({ id: r.id, name: r.name })) || []}
          groups={groups.data?.groups.map((g) => ({ id: g.id, name: g.name })) || []}
          depts={depts.data?.departments.map((d) => ({ id: d.id, name: `${d.path} ${d.name}` })) || []}
          nodes={nodes.data?.nodes.map((n) => ({ id: n.id, name: `${n.name} (${n.host}:${n.port})` })) || []}
          assetGroups={assetGroups.data?.asset_groups.map((g) => ({ id: g.id, name: `${g.path} ${g.name}` })) || []}
          tags={tags.data?.tags.map((t) => ({ id: t.id, name: t.name })) || []}
          onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "grants"] })}
        />
      </div>
      <DataTable columns={cols} rows={list.data?.grants} loading={list.isLoading} />
    </div>
  )
}

type Option = { id: number; name: string }

function CreateGrantDialog({
  users, roles, groups, depts, nodes, assetGroups, tags, onCreated,
}: {
  users: Option[]
  roles: Option[]
  groups: Option[]
  depts: Option[]
  nodes: Option[]
  assetGroups: Option[]
  tags: Option[]
  onCreated: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [granteeType, setGranteeType] = React.useState<AssetGrant["grantee_type"]>("user")
  const [granteeId, setGranteeId] = React.useState<number>(0)
  const [subjectType, setSubjectType] = React.useState<AssetGrant["subject_type"]>("node")
  const [subjectId, setSubjectId] = React.useState<number>(0)
  const [actions, setActions] = React.useState<string[]>(["connect"])

  const create = useMutation({
    mutationFn: () => grantService.create({
      grantee_type: granteeType, grantee_id: granteeId,
      subject_type: subjectType, subject_id: subjectType === "all" ? 0 : subjectId,
      actions: actions.join(","),
    }),
    onSuccess: () => {
      setOpen(false)
      setGranteeId(0); setSubjectId(0); setActions(["connect"])
      onCreated()
      toast.success("已创建授权")
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  const granteeOptions: Option[] =
    granteeType === "user" ? users :
    granteeType === "role" ? roles :
    granteeType === "group" ? groups : depts
  const subjectOptions: Option[] =
    subjectType === "node" ? nodes :
    subjectType === "group" ? assetGroups :
    subjectType === "tag" ? tags : []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="w-4 h-4" /> 新建授权</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>新建资产授权</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>授给谁</Label>
              <Select value={granteeType} onValueChange={(v) => { setGranteeType(v as AssetGrant["grantee_type"]); setGranteeId(0) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">用户</SelectItem>
                  <SelectItem value="role">角色</SelectItem>
                  <SelectItem value="group">用户组</SelectItem>
                  <SelectItem value="department">部门</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>具体对象</Label>
              <Select value={granteeId ? String(granteeId) : ""} onValueChange={(v) => setGranteeId(Number(v))}>
                <SelectTrigger><SelectValue placeholder="选择" /></SelectTrigger>
                <SelectContent>
                  {granteeOptions.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>授权对象类型</Label>
              <Select value={subjectType} onValueChange={(v) => { setSubjectType(v as AssetGrant["subject_type"]); setSubjectId(0) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="node">单个节点</SelectItem>
                  <SelectItem value="group">资产组</SelectItem>
                  <SelectItem value="tag">标签</SelectItem>
                  <SelectItem value="all">全部资产</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {subjectType !== "all" && (
              <div className="space-y-1">
                <Label>具体对象</Label>
                <Select value={subjectId ? String(subjectId) : ""} onValueChange={(v) => setSubjectId(Number(v))}>
                  <SelectTrigger><SelectValue placeholder="选择" /></SelectTrigger>
                  <SelectContent>
                    {subjectOptions.map((o) => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label>允许的动作</Label>
            <div className="flex flex-wrap gap-2">
              {ACTIONS.map((a) => {
                const on = actions.includes(a.code)
                return (
                  <button
                    key={a.code}
                    type="button"
                    onClick={() => setActions(on ? actions.filter((x) => x !== a.code) : [...actions, a.code])}
                    className={`px-2 py-1 rounded border text-xs ${on ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                    title={a.label}
                  >
                    {a.code}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">点击勾选多个动作；包含 <code>*</code> 时其他动作会被覆盖。</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button
            disabled={!granteeId || (subjectType !== "all" && !subjectId) || actions.length === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
