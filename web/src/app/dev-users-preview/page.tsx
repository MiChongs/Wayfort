"use client"

// 临时预览页（验证用户系统视觉用，验证后删除）。用 mock 数据渲染概览卡 + 表格，
// 复用真实组件，不依赖 API / 登录。访问 /dev-users-preview。

import * as React from "react"
import { Ban, CheckCircle2, Clock, MoreHorizontal, Pencil, ShieldCheck, Users, UserX } from "lucide-react"
import { UserAvatar } from "@/components/common/user-avatar"
import { TagBadge } from "@/components/tags/tag-badge"
import { statusMeta } from "@/lib/user-status"
import { relTime } from "@/lib/format"
import type { AssetTag, Department, Role, User } from "@/lib/api/types"
import { UserFormSheet } from "@/components/admin/user-form-sheet"
import { cn } from "@/lib/utils"

const TAGS: Record<number, AssetTag> = {
  1: { id: 1, name: "运维", color: "coral" } as AssetTag,
  2: { id: 2, name: "外包", color: "amber" } as AssetTag,
  3: { id: 3, name: "DBA", color: "teal" } as AssetTag,
}

const NOW = "2026-06-07T02:00:00Z"
const ROWS: (User & { _dept: string; _tags: number[] })[] = [
  { id: 1, username: "zhang.wei", display_name: "张伟", email: "zhang.wei@acme.com", is_admin: true, status: "active", last_login_at: "2026-06-07T01:10:00Z", last_login_ip: "10.0.2.31", _dept: "平台组", _tags: [1] },
  { id: 2, username: "li.na", display_name: "李娜", email: "li.na@acme.com", status: "active", last_login_at: "2026-06-06T09:00:00Z", last_login_ip: "10.0.2.44", _dept: "DBA 组", _tags: [3] },
  { id: 3, username: "vendor.wang", display_name: "外包·王强", email: "wang@vendor.io", status: "suspended", last_login_at: "2026-05-20T03:00:00Z", last_login_ip: "203.0.113.7", _dept: "临时", _tags: [2] },
  { id: 4, username: "chen.departed", display_name: "陈旧", email: "chen@acme.com", status: "departed", _dept: "已撤销", _tags: [] },
  { id: 5, username: "zhou.locked", display_name: "周强", email: "zhou@acme.com", disabled: true, _dept: "安全组", _tags: [1] },
  { id: 6, username: "new.hire", display_name: "新同学", status: "active", _dept: "研发组", _tags: [] },
]

function Stat({ icon: Icon, label, value, tone, active }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; tone: string; active?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border bg-card p-3", active && "border-primary bg-primary/5 ring-1 ring-primary/20")}>
      <span className={cn("grid h-9 w-9 place-items-center rounded-lg", tone)}><Icon className="h-4 w-4" /></span>
      <span><span className="block text-2xl font-semibold tabular-nums">{value}</span><span className="mt-0.5 block text-xs text-muted-foreground">{label}</span></span>
    </div>
  )
}

function Panel({ dark }: { dark?: boolean }) {
  return (
    <div className={(dark ? "dark " : "") + "p-6"} style={{ background: dark ? "#181715" : "#faf9f5" }}>
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <p className="eyebrow">用户与权限</p>
          <h1 className="display-title text-3xl" style={{ color: dark ? "#faf9f5" : "#141413" }}>用户</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理谁能进来、以什么身份、能碰哪些资产——开号、停用、改归属，都在这里。</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Stat icon={Users} label="全部用户" value={128} tone="bg-primary/12 text-primary" active />
          <Stat icon={CheckCircle2} label="在职可用" value={110} tone="bg-[#5db872]/14 text-[#3f8f54] dark:text-[#7cc78a]" />
          <Stat icon={UserX} label="已禁用" value={8} tone="bg-destructive/10 text-destructive" />
          <Stat icon={ShieldCheck} label="管理员" value={4} tone="bg-primary/12 text-primary" />
          <Stat icon={Clock} label="近 7 天活跃" value={42} tone="bg-[#5db8a6]/14 text-[#3c8e7f] dark:text-[#79c7b8]" />
          <Stat icon={Ban} label="锁定 / 过期" value={3} tone="bg-[#d4a017]/12 text-[#a8721f] dark:text-[#e3b84e]" />
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2.5"><input type="checkbox" className="accent-primary" readOnly /></th>
                <th className="px-2 py-2.5 text-left font-medium">用户</th>
                <th className="px-3 py-2.5 text-left font-medium">部门 / 标签</th>
                <th className="px-3 py-2.5 text-left font-medium">状态</th>
                <th className="px-3 py-2.5 text-left font-medium">最近登录</th>
                <th className="px-3 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((u) => {
                const sm = statusMeta(u)
                return (
                  <tr key={u.id} className="border-t">
                    <td className="px-3 py-2.5"><input type="checkbox" className="accent-primary" readOnly /></td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <UserAvatar name={u.display_name || u.username} size="md" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium">{u.display_name}</span>
                            {u.is_admin && <ShieldCheck className="h-3.5 w-3.5 text-primary" />}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">{u.email || `@${u.username}`}</span>
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{u._dept}</span>
                        {u._tags.map((id) => <TagBadge key={id} tag={TAGS[id]} size="sm" showDot />)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", sm.chip)}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} /> {sm.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {u.last_login_at ? (
                        <div className="text-xs"><div>{relTime(u.last_login_at)}</div><div className="text-muted-foreground">{u.last_login_ip}</div></div>
                      ) : <span className="text-xs text-muted-foreground">从未</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1 text-muted-foreground">
                        <span className="inline-flex h-7 items-center rounded-md px-2 text-xs hover:bg-accent">详情</span>
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent"><Pencil className="h-3.5 w-3.5" /></span>
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent"><MoreHorizontal className="h-4 w-4" /></span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const MOCK_ROLES: Role[] = [
  { id: 1, name: "超级管理员", is_system: true } as Role,
  { id: 2, name: "运维工程师" } as Role,
  { id: 3, name: "数据库管理员" } as Role,
  { id: 4, name: "只读审计" } as Role,
]
const MOCK_DEPTS: Department[] = [
  { id: 1, name: "平台组", path: "平台组" } as Department,
  { id: 2, name: "DBA 组", path: "平台组/DBA 组" } as Department,
  { id: 3, name: "安全组", path: "安全组" } as Department,
]

function FormPreview() {
  // 客户端挂载后再开 sheet（避免 SSR 直接渲染 open 的 Radix portal），
  // 模拟真实页里点击「新建」后的条件渲染。
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <UserFormSheet mode="create" roles={MOCK_ROLES} depts={MOCK_DEPTS} onClose={() => {}} onSaved={() => {}} />
}

export default function DevUsersPreview() {
  return (
    <>
      <Panel />
      <FormPreview />
    </>
  )
}
