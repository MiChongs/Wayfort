"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Boxes,
  Check,
  Crown,
  Eye,
  Loader2,
  MonitorPlay,
  Pencil,
  Plus,
  Save,
  ScrollText,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Stamp,
  Users,
  Wrench,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { EmptyState } from "@/components/common/empty-state"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { roleService } from "@/lib/api/services"
import type { Permission, Role } from "@/lib/api/types"
import { cn } from "@/lib/utils"

const KEY = ["admin", "roles"] as const

// ----- category presentation ------------------------------------------------
// Mirrors the backend permission catalogue (internal/auth/permission.go). Maps
// the terse category keys to a friendly Chinese label + icon so the editor and
// the cards read like a product, not a database dump.
const CATEGORY_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  system: { label: "系统", icon: Settings2 },
  user: { label: "用户与组织", icon: Users },
  node: { label: "节点", icon: Server },
  asset: { label: "资产", icon: Boxes },
  session: { label: "会话", icon: MonitorPlay },
  ops: { label: "主机运维", icon: Wrench },
  approval: { label: "审批", icon: Stamp },
  audit: { label: "审计", icon: ScrollText },
  ai: { label: "AI 助手", icon: Sparkles },
}
const CATEGORY_ORDER = ["system", "user", "node", "asset", "session", "ops", "approval", "audit", "ai"]

function catMeta(cat: string) {
  return CATEGORY_META[cat] ?? { label: cat, icon: ShieldCheck }
}

// Friendly fallback blurbs for the seeded built-in roles (their stored
// description is often blank).
const BUILTIN_DESC: Record<string, string> = {
  admin: "拥有系统的全部权限，可管理一切。",
  operator: "日常运维：连接资产、申请端口转发、管理资产组与标签。",
  auditor: "只读审计：查看与回放会话、实时监看、查阅审计日志。",
  guest: "仅可使用 AI 助手，无管理权限。",
}

const SYSTEM_ADMIN = "system:admin"

function roleDesc(role: Role): string {
  return role.description?.trim() || BUILTIN_DESC[role.name] || "暂无描述"
}

// ----- page ------------------------------------------------------------------

export default function RolesPage() {
  const qc = useQueryClient()
  const rolesQ = useQuery({ queryKey: KEY, queryFn: roleService.list })
  const permsQ = useQuery({ queryKey: ["admin", "perms"], queryFn: roleService.permissions })
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY })

  const [active, setActive] = React.useState<{ mode: "create" | "edit" | "view"; role?: Role } | null>(null)

  const perms = permsQ.data?.permissions ?? []
  const permByCode = React.useMemo(() => {
    const m = new Map<string, Permission>()
    for (const p of perms) m.set(p.code, p)
    return m
  }, [perms])

  const remove = useMutation({
    mutationFn: (id: number) => roleService.remove(id),
    onSuccess: () => {
      invalidate()
      toast.success("角色已删除")
    },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })

  // Built-in first, then custom — both alphabetical, so the page reads top-down
  // from the most privileged baked-in roles to the org's own.
  const roles = React.useMemo(() => {
    const list = [...(rolesQ.data?.roles ?? [])]
    return list.sort((a, b) => {
      if (!!a.is_system !== !!b.is_system) return a.is_system ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [rolesQ.data])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ShieldCheck className="size-5" /> 角色与权限
          </h1>
          <p className="text-sm text-muted-foreground">
            角色是一组权限的集合。把角色分配给用户，即可决定他们能在系统里做什么。
          </p>
        </div>
        <Button onClick={() => setActive({ mode: "create" })}>
          <Plus className="size-4" /> 新建角色
        </Button>
      </div>

      {rolesQ.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : roles.length === 0 ? (
        <div className="rounded-xl border">
          <EmptyState
            icon={ShieldCheck}
            title="还没有角色"
            description="新建一个角色，挑选它能执行的权限，再分配给用户。"
            action={
              <Button onClick={() => setActive({ mode: "create" })}>
                <Plus className="size-4" /> 新建角色
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {roles.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              permByCode={permByCode}
              onOpen={() => setActive({ mode: role.is_system ? "view" : "edit", role })}
              onDelete={() => remove.mutate(role.id)}
              deleting={remove.isPending}
            />
          ))}
        </div>
      )}

      <RoleSheet
        active={active}
        perms={perms}
        onClose={() => setActive(null)}
        onSaved={() => {
          invalidate()
          setActive(null)
        }}
      />
    </div>
  )
}

// ----- role card -------------------------------------------------------------

function RoleCard({
  role,
  permByCode,
  onOpen,
  onDelete,
  deleting,
}: {
  role: Role
  permByCode: Map<string, Permission>
  onOpen: () => void
  onDelete: () => void
  deleting: boolean
}) {
  const isSystem = !!role.is_system
  const codes = role.permissions ?? []
  const hasAll = codes.includes(SYSTEM_ADMIN)
  const Icon = hasAll ? Crown : ShieldCheck

  // Distinct categories this role touches (excluding the catch-all system:admin).
  const cats = React.useMemo(() => {
    const seen = new Set<string>()
    for (const code of codes) {
      if (code === SYSTEM_ADMIN) continue
      const c = permByCode.get(code)?.category
      if (c) seen.add(c)
    }
    return CATEGORY_ORDER.filter((c) => seen.has(c))
  }, [codes, permByCode])

  return (
    <Card className="flex flex-col gap-0 overflow-hidden p-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex-1 cursor-pointer p-4 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full",
              hasAll ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
            )}
          >
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium truncate">{role.name}</span>
              <Badge variant={isSystem ? "soft" : "outline"} className="rounded-full">
                {isSystem ? "内置" : "自定义"}
              </Badge>
            </div>
            <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{roleDesc(role)}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {hasAll ? (
            <Badge variant="coral" className="gap-1 rounded-full">
              <Crown className="size-3" /> 全部权限
            </Badge>
          ) : codes.length === 0 ? (
            <span className="text-xs text-muted-foreground">尚未分配权限</span>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">{codes.length} 项 ·</span>
              {cats.slice(0, 4).map((c) => {
                const m = catMeta(c)
                const CIcon = m.icon
                return (
                  <Badge key={c} variant="soft" className="gap-1 rounded-full font-normal">
                    <CIcon className="size-3" /> {m.label}
                  </Badge>
                )
              })}
              {cats.length > 4 && (
                <Badge variant="soft" className="rounded-full font-normal">
                  +{cats.length - 4}
                </Badge>
              )}
            </>
          )}
        </div>
      </button>

      <div className="flex items-center justify-end gap-1 border-t bg-muted/20 px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onOpen}>
          {isSystem ? (
            <>
              <Eye className="size-4" /> 查看
            </>
          ) : (
            <>
              <Pencil className="size-4" /> 编辑
            </>
          )}
        </Button>
        {!isSystem && (
          <ConfirmDeleteIconButton
            title={`删除角色「${role.name}」？`}
            description="已分配此角色的用户会立刻失去对应权限。该操作不可恢复。"
            loading={deleting}
            onConfirm={onDelete}
          />
        )}
      </div>
    </Card>
  )
}

// ----- role editor sheet -----------------------------------------------------

function RoleSheet({
  active,
  perms,
  onClose,
  onSaved,
}: {
  active: { mode: "create" | "edit" | "view"; role?: Role } | null
  perms: Permission[]
  onClose: () => void
  onSaved: () => void
}) {
  // Retain the last opened payload so the content stays stable through the
  // close animation (active goes null the moment the sheet starts closing).
  const [snap, setSnap] = React.useState(active)
  React.useEffect(() => {
    if (active) setSnap(active)
  }, [active])

  const role = snap?.role
  const readOnly = snap?.mode === "view"
  const isCreate = snap?.mode === "create"

  const [name, setName] = React.useState("")
  const [desc, setDesc] = React.useState("")
  const [chosen, setChosen] = React.useState<Set<string>>(new Set())
  const [search, setSearch] = React.useState("")

  // Reset the form whenever a (new) role/mode is opened.
  React.useEffect(() => {
    if (!active) return
    setName(active.role?.name ?? "")
    setDesc(active.role?.description ?? "")
    setChosen(new Set(active.role?.permissions ?? []))
    setSearch("")
  }, [active])

  const groups = React.useMemo(() => {
    const byCat = new Map<string, Permission[]>()
    for (const p of perms) {
      const c = p.category || "other"
      const arr = byCat.get(c) ?? []
      arr.push(p)
      byCat.set(c, arr)
    }
    const order = [...CATEGORY_ORDER, ...Array.from(byCat.keys()).filter((c) => !CATEGORY_ORDER.includes(c))]
    return order.filter((c) => byCat.has(c)).map((c) => ({ cat: c, items: byCat.get(c)! }))
  }, [perms])

  const q = search.trim().toLowerCase()
  const matches = (p: Permission) =>
    !q || p.code.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q)

  const toggle = (code: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (on) next.add(code)
      else next.delete(code)
      return next
    })

  const toggleGroup = (codes: string[], on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev)
      for (const c of codes) {
        if (on) next.add(c)
        else next.delete(c)
      }
      return next
    })

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: desc.trim(), permissions: Array.from(chosen) }
      return isCreate ? roleService.create(body) : roleService.update(role!.id, body)
    },
    onSuccess: () => {
      onSaved()
      toast.success(isCreate ? "角色已创建" : "角色已更新")
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  const title = isCreate ? "新建角色" : readOnly ? role?.name : `编辑「${role?.name}」`

  return (
    <Sheet open={!!active} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="space-y-1 border-b px-6 pb-4 pt-6">
          <SheetTitle className="flex items-center gap-2">
            {readOnly ? <Eye className="size-4" /> : <ShieldCheck className="size-4" />}
            {title}
          </SheetTitle>
          <SheetDescription>
            {readOnly
              ? "内置角色不可修改，下方为它包含的权限。"
              : "填写名称，再勾选这个角色可以执行的操作。"}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 px-6 py-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="role-name">名称</Label>
                <Input
                  id="role-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：运维值班"
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role-desc">描述</Label>
                <Input
                  id="role-desc"
                  value={readOnly ? roleDesc(role!) : desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="一句话说明这个角色"
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm">
                  权限
                  <span className="ml-2 font-normal text-muted-foreground">已选 {chosen.size} 项</span>
                </Label>
                <div className="relative w-44">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索权限"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              </div>

              <div className="space-y-3">
                {groups.map(({ cat, items }) => {
                  const visible = items.filter(matches)
                  if (visible.length === 0) return null
                  const m = catMeta(cat)
                  const CIcon = m.icon
                  const codes = items.map((p) => p.code)
                  const onCount = codes.filter((c) => chosen.has(c)).length
                  const allOn = onCount === codes.length
                  const someOn = onCount > 0 && !allOn
                  return (
                    <div key={cat} className="overflow-hidden rounded-lg border">
                      <div className="flex items-center gap-2.5 border-b bg-muted/30 px-3 py-2">
                        <Checkbox
                          checked={allOn ? true : someOn ? "indeterminate" : false}
                          onCheckedChange={(v) => toggleGroup(codes, v === true)}
                          disabled={readOnly}
                          aria-label={`全选${m.label}`}
                        />
                        <CIcon className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{m.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {onCount}/{codes.length}
                        </span>
                      </div>
                      <ul className="divide-y">
                        {visible.map((p) => {
                          const on = chosen.has(p.code)
                          return (
                            <li key={p.code}>
                              <label
                                className={cn(
                                  "flex items-start gap-3 px-3 py-2.5",
                                  readOnly ? "cursor-default" : "cursor-pointer hover:bg-accent/40",
                                )}
                              >
                                <Checkbox
                                  checked={on}
                                  onCheckedChange={(v) => toggle(p.code, v === true)}
                                  disabled={readOnly}
                                  className="mt-0.5"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm">{p.description || p.code}</span>
                                    {p.code === SYSTEM_ADMIN && (
                                      <Badge variant="coral" className="rounded-full text-[10px]">
                                        超级权限
                                      </Badge>
                                    )}
                                  </div>
                                  <code className="font-mono text-xs text-muted-foreground">{p.code}</code>
                                </div>
                                {on && <Check className="mt-0.5 size-4 shrink-0 text-success" />}
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </ScrollArea>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t bg-secondary/40 px-6 py-3">
          <Button variant="outline" onClick={onClose}>
            {readOnly ? "关闭" : "取消"}
          </Button>
          {!readOnly && (
            <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {isCreate ? "创建角色" : "保存修改"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
