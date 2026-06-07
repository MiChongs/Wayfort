"use client"

// 用户 360° 详情抽屉。一屏看清一个人：资料 / 状态 / 角色 / 部门 / 标签 / 最近会话 /
// 登录历史 / 被授权资产，并能就地重置密码、踢下线、启停。文案口语化，不说空话。

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Ban, CircleCheck, Clock, KeyRound, LogOut, Mail, Pencil, Phone,
  ShieldAlert, ShieldCheck, TriangleAlert,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { userService, tagService } from "@/lib/api/services"
import type { AssetGrant, Department, LoginHistory, Session, User } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { UserAvatar } from "@/components/common/user-avatar"
import { TagBadge } from "@/components/tags/tag-badge"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { kindMeta, statusMeta, fmtDuration } from "@/lib/session-meta"
import { fullTime, relTime } from "@/lib/format"
import { statusMeta as userStatusMeta } from "@/lib/user-status"
import { cn } from "@/lib/utils"

const SUBJECT_LABEL: Record<string, string> = {
  node: "资产", group: "资产组", tag: "标签", department: "部门", all: "全部资产",
}

export function UserDetailSheet({
  userId,
  depts,
  onClose,
  onEdit,
}: {
  userId: number
  depts: Department[]
  onClose: () => void
  onEdit: (u: User) => void
}) {
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: ["admin", "user-detail", userId],
    queryFn: () => userService.detail(userId),
  })
  const tagList = useQuery({ queryKey: ["tags"], queryFn: tagService.list })
  const [resetting, setResetting] = React.useState(false)
  const [pw, setPw] = React.useState("")

  const u = detail.data?.user
  const refetchAll = () => {
    detail.refetch()
    qc.invalidateQueries({ queryKey: ["admin", "users"] })
  }

  const toggleDisabled = useMutation({
    mutationFn: () => userService.update(userId, { disabled: !u?.disabled }),
    onSuccess: () => { toast.success(u?.disabled ? "已启用账号" : "已禁用账号"); refetchAll() },
    onError: (e: unknown) => toast.error("操作失败", { description: (e as Error).message }),
  })
  const forceLogout = useMutation({
    mutationFn: () => userService.forceLogout(userId),
    onSuccess: () => toast.success("已强制下线，该用户的令牌立即失效"),
    onError: (e: unknown) => toast.error("操作失败", { description: (e as Error).message }),
  })
  const reset = useMutation({
    mutationFn: () => userService.resetPassword(userId, pw),
    onSuccess: () => { toast.success("密码已重置"); setResetting(false); setPw("") },
    onError: (e: unknown) => toast.error("重置失败", { description: (e as Error).message }),
  })

  const tagsById = React.useMemo(() => {
    const m = new Map<number, NonNullable<typeof tagList.data>["tags"][number]>()
    for (const t of tagList.data?.tags ?? []) m.set(t.id, t)
    return m
  }, [tagList.data])
  const deptName = (id: number) => depts.find((d) => d.id === id)?.name ?? `#${id}`

  const sm = u ? userStatusMeta(u) : null

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {/* 头部 */}
        <SheetHeader className="border-b px-6 py-4">
          <div className="flex items-start gap-3">
            <UserAvatar name={u?.display_name || u?.username || "?"} src={u?.avatar_url} size="lg" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex items-center gap-2 truncate">
                {u?.display_name || u?.username || "加载中…"}
                {sm && (
                  <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", sm.chip)}>
                    {sm.label}
                  </span>
                )}
              </SheetTitle>
              <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">@{u?.username}</div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                {u?.email && <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{u.email}</span>}
                {u?.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{u.phone}</span>}
                <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" />
                  {u?.last_login_at ? `最近登录 ${relTime(u.last_login_at)}` : "从未登录"}
                </span>
              </div>
            </div>
          </div>
          {/* 就地操作 */}
          {u && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => onEdit(u)}><Pencil className="h-3.5 w-3.5" /> 编辑</Button>
              <Button size="sm" variant="outline" onClick={() => setResetting((v) => !v)}><KeyRound className="h-3.5 w-3.5" /> 重置密码</Button>
              <Button size="sm" variant="outline" onClick={async () => {
                if (await confirmDialog({ title: `把 ${u.username} 踢下线？`, description: "该用户当前所有令牌会立即失效，需要重新登录。", confirmLabel: "强制下线", destructive: true })) forceLogout.mutate()
              }}><LogOut className="h-3.5 w-3.5" /> 强制下线</Button>
              <Button size="sm" variant={u.disabled ? "default" : "outline"} onClick={() => toggleDisabled.mutate()}>
                {u.disabled ? <><CircleCheck className="h-3.5 w-3.5" /> 启用</> : <><Ban className="h-3.5 w-3.5" /> 禁用</>}
              </Button>
            </div>
          )}
          {resetting && (
            <div className="mt-2 flex items-center gap-2 rounded-lg border bg-muted/40 p-2">
              <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="新密码（≥ 8 位）" className="h-8" />
              <Button size="sm" disabled={pw.length < 8 || reset.isPending} onClick={() => reset.mutate()}>确认</Button>
            </div>
          )}
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {detail.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/50" />)}
            </div>
          ) : !u ? (
            <EmptyState icon={TriangleAlert} title="加载失败" description="没找到这个用户，可能已被删除。" />
          ) : (
            <>
              {/* 安全状态 */}
              <Block title="安全状态">
                <div className="flex flex-wrap gap-2">
                  <Pill on={u.is_admin} icon={ShieldCheck} label="管理员" tone="coral" />
                  <Pill on={u.mfa_enforced} icon={ShieldCheck} label="强制 MFA" tone="teal" />
                  <Pill on={u.passkey_only} icon={KeyRound} label="仅 Passkey" tone="teal" />
                  <Pill on={!!u.locked_until && new Date(u.locked_until) > new Date()} icon={ShieldAlert} label="已锁定" tone="amber" />
                  {u.expires_at && (
                    <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" /> {new Date(u.expires_at) < new Date() ? "已过期" : "到期"} {fullTime(u.expires_at).slice(0, 10)}
                    </span>
                  )}
                </div>
                {u.note && <p className="mt-2 rounded-lg border bg-muted/30 p-2.5 text-[13px] leading-relaxed text-muted-foreground">{u.note}</p>}
              </Block>

              {/* 角色 / 部门 / 标签 */}
              <Block title="角色 · 部门 · 标签">
                <div className="space-y-2.5">
                  <Row label="角色">
                    {detail.data?.roles?.length
                      ? detail.data.roles.map((r) => <Chip key={r.id}>{r.is_system ? <ShieldCheck className="h-3 w-3" /> : null}{r.name}</Chip>)
                      : <Muted>未分配角色</Muted>}
                  </Row>
                  <Row label="部门">
                    {u.department_ids?.length
                      ? u.department_ids.map((id) => <Chip key={id}>{deptName(id)}</Chip>)
                      : <Muted>未归属部门</Muted>}
                  </Row>
                  <Row label="标签">
                    {u.tag_ids?.length
                      ? u.tag_ids.map((id) => { const t = tagsById.get(id); return t ? <TagBadge key={id} tag={t} size="sm" showDot /> : null })
                      : <Muted>没有标签</Muted>}
                  </Row>
                </div>
              </Block>

              {/* 最近会话 */}
              <Block title="最近会话" count={detail.data?.session_total}>
                {detail.data?.sessions?.length
                  ? <div className="space-y-1">{detail.data.sessions.map((s) => <SessionLine key={s.id} s={s} />)}</div>
                  : <Muted>还没有接入记录</Muted>}
              </Block>

              {/* 登录历史 */}
              <Block title="登录历史">
                {detail.data?.login_history?.length
                  ? <div className="space-y-1">{detail.data.login_history.map((h) => <LoginLine key={h.id} h={h} />)}</div>
                  : <Muted>暂无登录记录</Muted>}
              </Block>

              {/* 被授权资产 */}
              <Block title="直接授权" count={detail.data?.grants?.length}>
                {detail.data?.grants?.length
                  ? <div className="space-y-1">{detail.data.grants.map((g) => <GrantLine key={g.id} g={g} />)}</div>
                  : <Muted>没有直接授予的资产（可能通过角色/部门继承）</Muted>}
                <Link href={"/admin/asset-grants" as never} className="mt-1 inline-block text-xs text-primary hover:underline">管理授权 →</Link>
              </Block>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Block({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="eyebrow">{title}</h3>
        {typeof count === "number" && count > 0 && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
      </div>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-10 shrink-0 pt-1 text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2.5 py-0.5 text-xs">{children}</span>
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>
}

function Pill({ on, icon: Icon, label, tone }: { on?: boolean; icon: React.ComponentType<{ className?: string }>; label: string; tone: "coral" | "teal" | "amber" }) {
  if (!on) return null
  const toneCls = {
    coral: "border-[#cc785c]/30 text-[#b35f43] dark:text-[#e0997f]",
    teal: "border-[#5db8a6]/30 text-[#3c8e7f] dark:text-[#79c7b8]",
    amber: "border-[#d4a017]/40 text-[#a8721f] dark:text-[#e3b84e]",
  }[tone]
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium", toneCls)}>
      <Icon className="h-3.5 w-3.5" /> {label}
    </span>
  )
}

function SessionLine({ s }: { s: Session }) {
  const km = kindMeta(s.kind)
  const sm = statusMeta(s.status)
  const Icon = km.icon
  return (
    <Link href={`/sessions/${s.id}` as never} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent/40">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Icon className="h-3.5 w-3.5" /></span>
      <span className="min-w-0 flex-1 truncate">{s.node_name || "匿名目标"}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmtDuration(s.started_at, s.ended_at)}</span>
      <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", sm.tone === "destructive" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{sm.label}</span>
    </Link>
  )
}

function LoginLine({ h }: { h: LoginHistory }) {
  const ok = h.result === "success"
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", ok ? "bg-[#5db872]" : "bg-destructive")} />
      <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{h.ip || "—"}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{ok ? "登录成功" : h.reason || "登录失败"}</span>
      {h.anomaly && <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-[#d4a017]" />}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relTime(h.created_at)}</span>
    </div>
  )
}

function GrantLine({ g }: { g: AssetGrant }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-card px-2.5 py-1.5 text-sm">
      <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">{SUBJECT_LABEL[g.subject_type] ?? g.subject_type}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{g.subject_type === "all" ? "全部资产" : `#${g.subject_id}`}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{g.actions}</span>
    </div>
  )
}
