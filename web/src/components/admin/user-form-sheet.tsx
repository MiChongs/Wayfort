"use client"

// 新建 / 编辑用户表单（Sheet）。分组排布、人性化文案，覆盖基本信息、登录凭据、
// 账号生命周期（在职/停用/离职 + 到期日）、安全开关、归属（部门/角色/标签）与
// 管理员备注。严格走 DESIGN.md 的暖色语言；不堆砌 AI 腔的空话。

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Dice5, Shield, UserCog, UserPlus } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { userService } from "@/lib/api/services"
import type { Department, Role, User } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import { TagPicker } from "@/components/tags/tag-picker"
import { UserAvatar } from "@/components/common/user-avatar"
import { cn } from "@/lib/utils"

type Mode = "create" | "edit"

const STATUSES: { key: string; label: string; hint: string }[] = [
  { key: "active", label: "在职", hint: "正常使用，可登录" },
  { key: "suspended", label: "停用", hint: "保留账号，暂时禁止登录" },
  { key: "departed", label: "离职", hint: "归档账号，禁止登录" },
]

function genPassword(): string {
  // 去掉易混字符（0/O、1/l/I），保证可读又够强。
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*"
  const buf = new Uint32Array(18)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => chars[n % chars.length]).join("")
}

function toDateInput(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : ""
}

export function UserFormSheet({
  mode,
  user,
  roles,
  depts,
  initialRoleIds = [],
  onClose,
  onSaved,
}: {
  mode: Mode
  user?: User
  roles: Role[]
  depts: Department[]
  initialRoleIds?: number[]
  onClose: () => void
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = React.useState(() => ({
    username: user?.username ?? "",
    password: "",
    display_name: user?.display_name ?? "",
    email: user?.email ?? "",
    phone: user?.phone ?? "",
    is_admin: user?.is_admin ?? false,
    disabled: user?.disabled ?? false,
    mfa_enforced: user?.mfa_enforced ?? false,
    passkey_only: user?.passkey_only ?? false,
    status: user?.status || "active",
    note: user?.note ?? "",
    department_ids: user?.department_ids ?? (user?.department_id != null ? [user.department_id] : []),
  }))
  const [expiresDate, setExpiresDate] = React.useState(toDateInput(user?.expires_at))
  const [roleIds, setRoleIds] = React.useState<number[]>(initialRoleIds)
  const [tagIds, setTagIds] = React.useState<number[]>(user?.tag_ids ?? [])

  // 编辑时拉取用户当前角色作初值 —— 否则保存会用空数组覆盖、把角色清空。
  const currentRoles = useQuery({
    queryKey: ["admin", "user-roles", user?.id],
    queryFn: () => userService.listRoles(user!.id),
    enabled: mode === "edit" && !!user,
  })
  React.useEffect(() => {
    if (currentRoles.data?.roles) setRoleIds(currentRoles.data.roles.map((r) => r.id))
  }, [currentRoles.data])

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [k]: v }))

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...draft,
        tag_ids: tagIds,
        // date input → 到期当天结束；清空则永不过期。
        expires_at: expiresDate ? new Date(expiresDate + "T23:59:59").toISOString() : null,
      }
      if (mode === "create") {
        const created = await userService.create(body as never)
        if (roleIds.length) await userService.replaceRoles(created.id, roleIds)
      } else if (user) {
        await userService.update(user.id, body)
        await userService.replaceRoles(user.id, roleIds)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] })
      toast.success(mode === "create" ? "已创建用户" : "已保存修改")
      onSaved()
    },
    onError: (e: unknown) => toast.error(mode === "create" ? "创建失败" : "保存失败", { description: (e as Error).message }),
  })

  const displayName = draft.display_name || draft.username || "新用户"
  const canSave = mode === "edit" || (draft.username.trim() && draft.password.length >= 8)

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 py-4">
          <div className="flex items-center gap-3">
            <UserAvatar name={displayName} src={user?.avatar_url} size="lg" />
            <div className="min-w-0">
              <SheetTitle className="truncate">
                {mode === "create" ? "新建用户" : `编辑 · ${user?.username}`}
              </SheetTitle>
              <SheetDescription className="truncate">
                {mode === "create" ? "建一个新账号，并安排好归属与权限。" : "改资料、归属、权限与账号状态。"}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* 基本信息 */}
          <Section title="基本信息">
            <div className="grid grid-cols-2 gap-3">
              {mode === "create" ? (
                <Field label="用户名" required>
                  <Input value={draft.username} onChange={(e) => set("username", e.target.value)} placeholder="登录用，唯一" />
                </Field>
              ) : (
                <Field label="用户名">
                  <Input value={draft.username} disabled className="opacity-70" />
                </Field>
              )}
              <Field label="显示名">
                <Input value={draft.display_name} onChange={(e) => set("display_name", e.target.value)} placeholder="真名 / 昵称" />
              </Field>
              <Field label="邮箱">
                <Input value={draft.email} onChange={(e) => set("email", e.target.value)} placeholder="name@company.com" />
              </Field>
              <Field label="电话">
                <Input value={draft.phone} onChange={(e) => set("phone", e.target.value)} placeholder="选填" />
              </Field>
            </div>
          </Section>

          {/* 登录凭据（仅新建） */}
          {mode === "create" && (
            <Section title="登录凭据">
              <Field label="初始密码" required hint="至少 8 位。建议生成后通过安全渠道转交，并要求首次登录修改。">
                <div className="flex gap-2">
                  <Input
                    value={draft.password}
                    onChange={(e) => set("password", e.target.value)}
                    placeholder="≥ 8 位"
                    className="font-mono"
                  />
                  <Button type="button" variant="outline" size="icon" title="随机生成" onClick={() => set("password", genPassword())}>
                    <Dice5 className="h-4 w-4" />
                  </Button>
                </div>
              </Field>
            </Section>
          )}

          {/* 账号状态 */}
          <Section title="账号状态">
            <div className="grid grid-cols-3 gap-2">
              {STATUSES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => set("status", s.key)}
                  title={s.hint}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors",
                    draft.status === s.key ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "hover:bg-accent/40",
                  )}
                >
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{s.hint}</div>
                </button>
              ))}
            </div>
            <Field label="账号到期日" hint="到这天结束后自动拒绝登录。留空表示永不过期。">
              <Input type="date" value={expiresDate} onChange={(e) => setExpiresDate(e.target.value)} className="w-48" />
            </Field>
          </Section>

          {/* 安全 */}
          <Section title="安全">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Toggle label="管理员" hint="拥有平台最高权限" checked={draft.is_admin} onChange={(v) => set("is_admin", v)} />
              <Toggle label="已禁用" hint="立即冻结，无法登录" checked={draft.disabled} onChange={(v) => set("disabled", v)} />
              <Toggle label="强制 MFA" hint="登录必须二次验证" checked={draft.mfa_enforced} onChange={(v) => set("mfa_enforced", v)} />
              <Toggle label="仅 Passkey" hint="只允许通行密钥登录" checked={draft.passkey_only} onChange={(v) => set("passkey_only", v)} />
            </div>
          </Section>

          {/* 归属 */}
          <Section title="归属与权限">
            <Field label="部门" hint="可多选；决定数据范围与授权继承。">
              <DeptPicker depts={depts} value={draft.department_ids} onChange={(v) => set("department_ids", v)} />
            </Field>
            <Field label="角色" hint="决定能做什么操作（RBAC）。">
              <RolePicker roles={roles} value={roleIds} onChange={setRoleIds} />
            </Field>
            <Field label="标签" hint="给人打标签，便于分组与检索。">
              <TagPicker value={tagIds} onChange={setTagIds} placeholder="选择或创建标签…" />
            </Field>
          </Section>

          {/* 备注 */}
          <Section title="管理员备注">
            <Textarea
              value={draft.note}
              onChange={(e) => set("note", e.target.value)}
              placeholder="为什么开这个号、归属谁、有什么注意事项…"
              rows={3}
            />
          </Section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {mode === "create" ? <><UserPlus className="h-4 w-4" /> 创建用户</> : <><UserCog className="h-4 w-4" /> 保存修改</>}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  )
}

function Field({
  label, required, hint, children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[13px]">
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Toggle({
  label, hint, checked, onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-accent/30">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11px] leading-tight text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

function DeptPicker({ depts, value, onChange }: { depts: Department[]; value: number[]; onChange: (v: number[]) => void }) {
  if (depts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        还没有部门。先到 <Link href={"/admin/organization" as never} className="text-primary hover:underline">组织架构</Link> 创建。
      </p>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border p-2">
      {depts.map((d) => {
        const on = value.includes(d.id)
        const depth = Math.max(0, (d.path?.split("/").length ?? 1) - 1)
        return (
          <button
            key={d.id}
            type="button"
            title={d.path}
            onClick={() => onChange(on ? value.filter((x) => x !== d.id) : [...value, d.id])}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
            style={depth > 0 ? { marginLeft: depth * 8 } : undefined}
          >
            {d.name}
          </button>
        )
      })}
    </div>
  )
}

function RolePicker({ roles, value, onChange }: { roles: Role[]; value: number[]; onChange: (v: number[]) => void }) {
  if (roles.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        还没有角色。先到 <Link href={"/admin/roles" as never} className="text-primary hover:underline">角色管理</Link> 创建。
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
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
              on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            {r.is_system ? <Shield className="h-3 w-3" /> : null}
            {r.name}
          </button>
        )
      })}
    </div>
  )
}
