"use client"

// 用户管理 —— 概览看板 + 强筛选 + 批量操作 + 自绘表格 + 360 详情抽屉。
// 设计语言贴 DESIGN.md（暖卡片 / hairline / 克制阴影 / coral 强调），文案口语化。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  Ban, CheckCircle2, ChevronLeft, ChevronRight, Clock, LockOpen, LogOut,
  MoreHorizontal, Pencil, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal,
  Trash2, UserCog, Users, UserX,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { departmentService, roleService, tagService, userService } from "@/lib/api/services"
import type { AssetTag, Department, Role, User } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { UserAvatar } from "@/components/common/user-avatar"
import { TagBadge } from "@/components/tags/tag-badge"
import { UserFormSheet } from "@/components/admin/user-form-sheet"
import { UserDetailSheet } from "@/components/admin/user-detail-sheet"
import { statusMeta } from "@/lib/user-status"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const PAGE_SIZE = 25

export default function UsersAdminPage() {
  const qc = useQueryClient()
  const [q, setQ] = React.useState("")
  const [dq, setDq] = React.useState("")
  const [status, setStatus] = React.useState("") // "" | active | suspended | departed | disabled
  const [deptId, setDeptId] = React.useState("")
  const [roleId, setRoleId] = React.useState("")
  const [tagId, setTagId] = React.useState("")
  const [activeDays, setActiveDays] = React.useState(0) // 0 = 不限
  const [sort, setSort] = React.useState<"username" | "created" | "login">("username")
  const [page, setPage] = React.useState(0)
  const [selected, setSelected] = React.useState<Set<number>>(new Set())
  const [creating, setCreating] = React.useState(false)
  const [editing, setEditing] = React.useState<User | null>(null)
  const [detailId, setDetailId] = React.useState<number | null>(null)

  React.useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])
  React.useEffect(() => { setPage(0); setSelected(new Set()) }, [dq, status, deptId, roleId, tagId, activeDays, sort])

  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: roleService.list })
  const depts = useQuery({ queryKey: ["admin", "depts"], queryFn: departmentService.list })
  const tags = useQuery({ queryKey: ["tags"], queryFn: tagService.list })
  const stats = useQuery({ queryKey: ["admin", "user-stats"], queryFn: () => userService.stats(14), refetchInterval: 60_000 })

  // disabled 是一个虚拟 status 选项：映射到 disabled=true 而非 status 列。
  const list = useQuery({
    queryKey: ["admin", "users", dq, status, deptId, roleId, tagId, activeDays, sort, page],
    queryFn: () => userService.list({
      search: dq || undefined,
      status: status && status !== "disabled" ? status : undefined,
      disabled: status === "disabled" ? "true" : undefined,
      department_id: deptId ? Number(deptId) : undefined,
      role_id: roleId ? Number(roleId) : undefined,
      tag_id: tagId ? Number(tagId) : undefined,
      active_days: activeDays || undefined,
      sort,
      order: sort === "username" ? "asc" : "desc",
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
  })

  const rows = list.data?.users ?? []
  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const deptById = React.useMemo(() => new Map((depts.data?.departments ?? []).map((d) => [d.id, d])), [depts.data])
  const tagById = React.useMemo(() => new Map((tags.data?.tags ?? []).map((t) => [t.id, t])), [tags.data])

  const refresh = () => { list.refetch(); stats.refetch() }

  const bulk = useMutation({
    mutationFn: (action: string) => userService.bulk({ ids: [...selected], action }),
    onSuccess: (_d, action) => {
      toast.success(`已${BULK_LABEL[action] ?? "处理"} ${selected.size} 个用户`)
      setSelected(new Set())
      refresh()
      qc.invalidateQueries({ queryKey: ["admin", "users"] })
    },
    onError: (e: unknown) => toast.error("批量操作失败", { description: (e as Error).message }),
  })

  const rowAction = useMutation({
    mutationFn: ({ id, kind }: { id: number; kind: "unlock" | "force-logout" | "delete" }) =>
      kind === "unlock" ? userService.unlock(id) : kind === "force-logout" ? userService.forceLogout(id) : userService.remove(id),
    onSuccess: (_d, v) => { toast.success(ROW_ACTION_LABEL[v.kind]); refresh() },
    onError: (e: unknown) => toast.error("操作失败", { description: (e as Error).message }),
  })

  const allOnPageSelected = rows.length > 0 && rows.every((u) => selected.has(u.id))
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) rows.forEach((u) => next.delete(u.id))
      else rows.forEach((u) => next.add(u.id))
      return next
    })
  }
  const toggleOne = (id: number) => setSelected((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  const hasFilters = !!(dq || status || deptId || roleId || tagId || activeDays)

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">用户与权限</p>
          <h1 className="display-title text-3xl">用户</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理谁能进来、以什么身份、能碰哪些资产——开号、停用、改归属，都在这里。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw className={cn("h-4 w-4", list.isFetching && "animate-spin")} /> 刷新
          </Button>
          <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> 新建用户</Button>
        </div>
      </header>

      {/* 概览条 + 趋势 */}
      <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr]">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard icon={Users} label="全部用户" value={stats.data?.total} active={!hasFilters} onClick={() => clearAll()} />
          <StatCard icon={CheckCircle2} label="在职可用" value={stats.data?.active} tone="sage" active={status === "active"} onClick={() => { clearAll(); setStatus("active") }} />
          <StatCard icon={UserX} label="已禁用" value={stats.data?.disabled} tone="rose" active={status === "disabled"} onClick={() => { clearAll(); setStatus("disabled") }} />
          <StatCard icon={ShieldCheck} label="管理员" value={stats.data?.admin} tone="coral" />
          <StatCard icon={Clock} label="近 7 天活跃" value={stats.data?.recent_7d} tone="teal" active={activeDays === 7} onClick={() => { clearAll(); setActiveDays(7) }} />
          <StatCard icon={Ban} label="锁定 / 过期" value={(stats.data?.locked ?? 0) + (stats.data?.expired ?? 0)} tone="amber" />
        </div>
        <TrendCard data={stats.data?.trend ?? []} />
      </div>

      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 用户名 / 显示名 / 邮箱" className="pl-8" />
        </div>
        <FilterSelect value={status} onChange={setStatus} placeholder="状态" options={[
          { v: "active", l: "在职" }, { v: "suspended", l: "停用" }, { v: "departed", l: "离职" }, { v: "disabled", l: "已禁用" },
        ]} />
        <FilterSelect value={deptId} onChange={setDeptId} placeholder="部门" options={(depts.data?.departments ?? []).map((d) => ({ v: String(d.id), l: d.name }))} />
        <FilterSelect value={roleId} onChange={setRoleId} placeholder="角色" options={(roles.data?.roles ?? []).map((r) => ({ v: String(r.id), l: r.name }))} />
        <FilterSelect value={tagId} onChange={setTagId} placeholder="标签" options={(tags.data?.tags ?? []).map((t: AssetTag) => ({ v: String(t.id), l: t.name }))} />
        <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
          <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="username">按用户名</SelectItem>
            <SelectItem value="created">最近创建</SelectItem>
            <SelectItem value="login">最近登录</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5" /> 共 {total.toLocaleString()} 人
        </div>
      </div>

      {/* 批量操作栏 */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">已选 {selected.size} 人</span>
          <span className="text-muted-foreground">·</span>
          <BulkBtn onClick={() => bulk.mutate("enable")} icon={CheckCircle2}>启用</BulkBtn>
          <BulkBtn onClick={() => bulk.mutate("disable")} icon={Ban}>禁用</BulkBtn>
          <BulkBtn onClick={() => bulk.mutate("force-logout")} icon={LogOut}>强制下线</BulkBtn>
          <BulkBtn onClick={async () => { if (await confirmDialog({ title: `删除选中的 ${selected.size} 个用户？`, description: "他们的会话 / 角色 / 部门 / MFA / 标签等关联数据都会被一并删除，不可恢复。", destructive: true, confirmLabel: "永久删除" })) bulk.mutate("delete") }} icon={Trash2} danger>删除</BulkBtn>
          <button className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      )}

      {/* 表格 */}
      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2.5"><input type="checkbox" className="accent-primary" checked={allOnPageSelected} onChange={toggleAll} /></th>
              <th className="px-2 py-2.5 text-left font-medium">用户</th>
              <th className="hidden px-3 py-2.5 text-left font-medium lg:table-cell">部门 / 标签</th>
              <th className="px-3 py-2.5 text-left font-medium">状态</th>
              <th className="hidden px-3 py-2.5 text-left font-medium md:table-cell">最近登录</th>
              <th className="px-3 py-2.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <UserRow
                key={u.id}
                u={u}
                selected={selected.has(u.id)}
                onToggle={() => toggleOne(u.id)}
                onOpen={() => setDetailId(u.id)}
                onEdit={() => setEditing(u)}
                deptById={deptById}
                tagById={tagById}
                onUnlock={() => rowAction.mutate({ id: u.id, kind: "unlock" })}
                onForceLogout={async () => { if (await confirmDialog({ title: `把 ${u.username} 踢下线？`, description: "该用户当前所有令牌立即失效。", confirmLabel: "强制下线", destructive: true })) rowAction.mutate({ id: u.id, kind: "force-logout" }) }}
                onDelete={async () => { if (await confirmDialog({ title: `删除用户 ${u.username}？`, description: "会话 / 角色 / 部门 / MFA / 标签等关联数据将一并删除，不可恢复。", destructive: true, confirmLabel: "永久删除" })) rowAction.mutate({ id: u.id, kind: "delete" }) }}
              />
            ))}
            {list.isLoading && Array.from({ length: 6 }).map((_, i) => (
              <tr key={`sk-${i}`} className="border-t"><td colSpan={6} className="px-4 py-3"><div className="h-9 animate-pulse rounded-md bg-muted/50" /></td></tr>
            ))}
            {!list.isLoading && rows.length === 0 && (
              <tr><td colSpan={6} className="p-2">
                <EmptyState icon={Users} title={hasFilters ? "没有匹配的用户" : "还没有用户"}
                  description={hasFilters ? "换个关键词或放宽筛选试试。" : "点右上角「新建用户」开第一个账号。"} />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-3 text-sm">
          <span className="text-xs text-muted-foreground">第 {page + 1} / {pages} 页</span>
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft className="h-4 w-4" /> 上一页</Button>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>下一页 <ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}

      {/* 抽屉 */}
      {creating && (
        <UserFormSheet mode="create" roles={roles.data?.roles ?? []} depts={depts.data?.departments ?? []}
          onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh() }} />
      )}
      {editing && (
        <UserFormSheet mode="edit" user={editing} roles={roles.data?.roles ?? []} depts={depts.data?.departments ?? []}
          initialRoleIds={[]} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />
      )}
      {detailId != null && (
        <UserDetailSheet userId={detailId} depts={depts.data?.departments ?? []}
          onClose={() => setDetailId(null)} onEdit={(u) => { setDetailId(null); setEditing(u) }} />
      )}
    </div>
  )

  function clearAll() { setStatus(""); setDeptId(""); setRoleId(""); setTagId(""); setActiveDays(0); setQ("") }
}

const BULK_LABEL: Record<string, string> = { enable: "启用", disable: "禁用", "force-logout": "下线", delete: "删除" }
const ROW_ACTION_LABEL: Record<string, string> = { unlock: "已解锁", "force-logout": "已强制下线", delete: "已删除" }

function StatCard({
  icon: Icon, label, value, tone, active, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string; value?: number; tone?: "sage" | "rose" | "coral" | "teal" | "amber"
  active?: boolean; onClick?: () => void
}) {
  const toneCls = {
    sage: "bg-[#5db872]/14 text-[#3f8f54] dark:text-[#7cc78a]",
    rose: "bg-destructive/10 text-destructive",
    coral: "bg-primary/12 text-primary",
    teal: "bg-[#5db8a6]/14 text-[#3c8e7f] dark:text-[#79c7b8]",
    amber: "bg-[#d4a017]/12 text-[#a8721f] dark:text-[#e3b84e]",
  }[tone ?? "coral"]
  return (
    <button type="button" disabled={!onClick} onClick={onClick}
      className={cn("flex items-center gap-3 rounded-xl border bg-card p-3 text-left transition-colors",
        onClick ? "hover:border-primary/40 hover:bg-accent/40" : "cursor-default",
        active && "border-primary bg-primary/5 ring-1 ring-primary/20")}>
      <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", toneCls)}><Icon className="h-4 w-4" /></span>
      <span className="min-w-0">
        <span className="block text-2xl font-semibold tabular-nums">{value ?? "—"}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </button>
  )
}

function TrendCard({ data }: { data: { date: string; count: number }[] }) {
  const config: ChartConfig = { count: { label: "新增", color: "var(--chart-1)" } }
  const total = data.reduce((a, b) => a + b.count, 0)
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium">近 14 天新增用户</span>
        <span className="text-xs tabular-nums text-muted-foreground">{total} 人</span>
      </div>
      {total === 0 ? (
        <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">这两周没有新增</div>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-[120px] w-full">
          <AreaChart data={data} margin={{ left: 0, right: 6, top: 6, bottom: 0 }}>
            <defs>
              <linearGradient id="fill-users" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-count)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-count)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={28} tickFormatter={(v: string) => v.slice(5)} />
            <YAxis hide allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area type="monotone" dataKey="count" stroke="var(--color-count)" strokeWidth={2} fill="url(#fill-users)" />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  )
}

function FilterSelect({ value, onChange, placeholder, options }: {
  value: string; onChange: (v: string) => void; placeholder: string; options: { v: string; l: string }[]
}) {
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
      <SelectTrigger className="h-9 w-auto min-w-[88px] gap-1"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">全部{placeholder}</SelectItem>
        {options.map((o) => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function BulkBtn({ onClick, icon: Icon, children, danger }: {
  onClick: () => void; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; danger?: boolean
}) {
  return (
    <button type="button" onClick={onClick}
      className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        danger ? "text-destructive hover:bg-destructive/10" : "hover:bg-accent")}>
      <Icon className="h-3.5 w-3.5" /> {children}
    </button>
  )
}

function UserRow({
  u, selected, onToggle, onOpen, onEdit, deptById, tagById, onUnlock, onForceLogout, onDelete,
}: {
  u: User; selected: boolean; onToggle: () => void; onOpen: () => void; onEdit: () => void
  deptById: Map<number, Department>; tagById: Map<number, AssetTag>
  onUnlock: () => void; onForceLogout: () => void; onDelete: () => void
}) {
  const sm = statusMeta(u)
  const deptIds = u.department_ids?.length ? u.department_ids : (u.department_id != null ? [u.department_id] : [])
  return (
    <tr className={cn("border-t transition-colors hover:bg-accent/30", selected && "bg-primary/5")}>
      <td className="px-3 py-2.5"><input type="checkbox" className="accent-primary" checked={selected} onChange={onToggle} /></td>
      <td className="px-2 py-2.5">
        <button onClick={onOpen} className="group flex items-center gap-2.5 text-left">
          <UserAvatar name={u.display_name || u.username} src={u.avatar_url} size="md" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-medium group-hover:underline">{u.display_name || u.username}</span>
              {u.is_admin && <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{u.email || `@${u.username}`}</span>
          </span>
        </button>
      </td>
      <td className="hidden px-3 py-2.5 lg:table-cell">
        <div className="flex flex-wrap items-center gap-1">
          {deptIds.slice(0, 1).map((id) => <span key={id} className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{deptById.get(id)?.name ?? `#${id}`}</span>)}
          {deptIds.length > 1 && <span className="text-xs text-muted-foreground">+{deptIds.length - 1}</span>}
          {(u.tag_ids ?? []).slice(0, 2).map((id) => { const t = tagById.get(id); return t ? <TagBadge key={id} tag={t} size="sm" showDot /> : null })}
          {(u.tag_ids?.length ?? 0) > 2 && <span className="text-xs text-muted-foreground">+{(u.tag_ids?.length ?? 0) - 2}</span>}
          {deptIds.length === 0 && !(u.tag_ids?.length) && <span className="text-xs text-muted-foreground">—</span>}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", sm.chip)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} /> {sm.label}
        </span>
      </td>
      <td className="hidden px-3 py-2.5 md:table-cell">
        {u.last_login_at ? (
          <div className="text-xs"><div>{relTime(u.last_login_at)}</div><div className="text-muted-foreground">{u.last_login_ip}</div></div>
        ) : <span className="text-xs text-muted-foreground">从未</span>}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1">
          <button onClick={onOpen} className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">详情</button>
          <button onClick={onEdit} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" title="编辑"><Pencil className="h-3.5 w-3.5" /></button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><MoreHorizontal className="h-4 w-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={onEdit}><UserCog className="h-4 w-4" /> 编辑资料</DropdownMenuItem>
              <DropdownMenuItem onClick={onUnlock}><LockOpen className="h-4 w-4" /> 解锁</DropdownMenuItem>
              <DropdownMenuItem onClick={onForceLogout}><LogOut className="h-4 w-4" /> 强制下线</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="h-4 w-4" /> 删除用户</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  )
}
