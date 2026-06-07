"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronRight, Pencil, Search, ShieldCheck, UserPlus, Users2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppIcon } from "@/components/icons/app-icon"
import { departmentService, groupService, grantService, userService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import type { User } from "@/lib/api/types"

export type OrgKind = "department" | "group"

export interface OrgEntity {
  id: number
  name: string
  description?: string
  icon?: string
  parent_id?: number | null
  path?: string
  order_idx?: number
  member_ids?: number[]
}

const DEFAULT_ICON: Record<OrgKind, string> = {
  department: "lucide:building-2",
  group: "lucide:users",
}

const NOUN: Record<OrgKind, string> = { department: "部门", group: "用户组" }

// OrgDetailPanel — the right-hand pane of the organisation page. Shows the
// selected department / user-group's identity, an at-a-glance stats strip
// (direct members · members incl. sub-tree · reachable assets), an inheritance
// hint, and an inline member manager (search the user directory, click to
// add / remove).
export function OrgDetailPanel({
  kind,
  entity,
  breadcrumb,
  subtreeMemberCount,
  onEdit,
  onChanged,
}: {
  kind: OrgKind
  entity: OrgEntity
  breadcrumb: string[]
  subtreeMemberCount: number
  onEdit: () => void
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const svc = kind === "department" ? departmentService : groupService

  const usersQ = useQuery({
    queryKey: ["admin", "users", "all-org"],
    queryFn: () => userService.list({ limit: 1000 }),
  })
  const users = React.useMemo(() => usersQ.data?.users ?? [], [usersQ.data])
  const usersById = React.useMemo(() => {
    const m = new Map<number, User>()
    for (const u of users) m.set(u.id, u)
    return m
  }, [users])

  // Reachable assets (with grant inheritance applied by the backend resolver).
  const accessQ = useQuery({
    queryKey: ["admin", "access", kind, entity.id],
    queryFn: () => grantService.byGrantee(kind, entity.id),
  })
  const reach = accessQ.data
    ? accessQ.data.all_actions.length > 0
      ? "全部资产"
      : String(accessQ.data.nodes.length)
    : "—"

  const [members, setMembers] = React.useState<Set<number>>(new Set(entity.member_ids ?? []))
  const [q, setQ] = React.useState("")
  React.useEffect(() => {
    setMembers(new Set(entity.member_ids ?? []))
    setQ("")
  }, [entity.id, entity.member_ids])

  const toggle = useMutation({
    mutationFn: async ({ userId, add }: { userId: number; add: boolean }) => {
      if (add) await svc.addMember(entity.id, userId)
      else await svc.removeMember(entity.id, userId)
    },
    onMutate: ({ userId, add }) => {
      setMembers((s) => {
        const next = new Set(s)
        if (add) next.add(userId)
        else next.delete(userId)
        return next
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "access"] })
      onChanged()
    },
    onError: (e: unknown, vars) => {
      setMembers((s) => {
        const next = new Set(s)
        if (vars.add) next.delete(vars.userId)
        else next.add(vars.userId)
        return next
      })
      toast.error("操作失败", { description: (e as Error).message })
    },
  })

  const filtered = React.useMemo(() => {
    const k = q.trim().toLowerCase()
    const list = users.filter((u) =>
      !k ? true : [u.username, u.display_name, u.email].filter(Boolean).join(" ").toLowerCase().includes(k),
    )
    return [...list].sort((a, b) => {
      const am = members.has(a.id) ? 0 : 1
      const bm = members.has(b.id) ? 0 : 1
      if (am !== bm) return am - bm
      return (a.display_name || a.username).localeCompare(b.display_name || b.username)
    })
  }, [users, q, members])

  const direct = members.size
  const inherited = Math.max(0, subtreeMemberCount - direct)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Identity header */}
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-primary">
            <AppIcon icon={entity.icon || DEFAULT_ICON[kind]} size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold tracking-tight">{entity.name}</h2>
              <Button variant="ghost" size="icon" className="h-7 w-7" title="编辑" onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
            {breadcrumb.length > 1 && (
              <div className="mt-0.5 flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
                {breadcrumb.map((name, i) => (
                  <span key={i} className="flex items-center gap-0.5">
                    {i > 0 && <ChevronRight className="h-3 w-3 opacity-50" />}
                    <span className={cn("truncate", i === breadcrumb.length - 1 && "text-foreground/80")}>
                      {name}
                    </span>
                  </span>
                ))}
              </div>
            )}
            {entity.description && (
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{entity.description}</p>
            )}
          </div>
        </div>

        {/* Stats strip */}
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Stat icon={Users2} label="直接成员" value={String(direct)} />
          <Stat
            icon={Users2}
            label="含子级"
            value={String(subtreeMemberCount)}
            hint={inherited > 0 ? `+${inherited} 来自子级` : undefined}
            muted
          />
          <Stat icon={ShieldCheck} label="可访问资产" value={reach} muted />
        </div>

        <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          子{NOUN[kind]}会自动继承本{NOUN[kind]}的资产授权；成员可属于多个{NOUN[kind]}。
        </p>
      </div>

      {/* Member manager */}
      <div className="border-b border-border px-5 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索用户 名称 / 用户名 / 邮箱…"
            className="h-9 pl-8"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {usersQ.isLoading && <div className="py-10 text-center text-sm text-muted-foreground">加载用户…</div>}
          {!usersQ.isLoading && filtered.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">没有匹配的用户</div>
          )}
          {filtered.map((u) => {
            const on = members.has(u.id)
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => toggle.mutate({ userId: u.id, add: !on })}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                  on ? "bg-primary/[0.06]" : "hover:bg-accent/60",
                )}
              >
                <Avatar user={u} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{u.display_name || u.username}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    @{u.username}
                    {u.email ? ` · ${u.email}` : ""}
                  </span>
                </span>
                <span
                  className={cn(
                    "grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors",
                    on ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent",
                  )}
                >
                  <Check className="h-3 w-3" />
                </span>
              </button>
            )
          })}
        </div>
      </ScrollArea>

      <div className="flex items-center gap-2 border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
        <UserPlus className="h-3.5 w-3.5" />
        点击用户行即可加入 / 移出本{NOUN[kind]}
        <span className="flex-1" />
        {usersById.size > 0 && <span>{usersById.size} 个用户</span>}
      </div>
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  muted,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  hint?: string
  muted?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={cn("mt-0.5 text-lg font-semibold tabular-nums", muted && "text-foreground/90")}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function Avatar({ user }: { user: User }) {
  const label = (user.display_name || user.username || "?").trim()
  const initials = label.slice(0, 2).toUpperCase()
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-muted-foreground">
      {initials}
    </span>
  )
}
