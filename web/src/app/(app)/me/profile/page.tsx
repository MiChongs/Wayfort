"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AtSign,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock,
  Crown,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Phone,
  RotateCcw,
  Save,
  ShieldCheck,
  User as UserIcon,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Progress } from "@/components/ui/progress"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { meService } from "@/lib/api/services"
import type { AccessTier, User } from "@/lib/api/types"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"

// ----- humanising lookups ----------------------------------------------------

const TIER_META: Record<
  AccessTier,
  { label: string; icon: React.ComponentType<{ className?: string }>; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  superadmin: { label: "超级管理员", icon: Crown, variant: "coral" },
  admin: { label: "管理员", icon: ShieldCheck, variant: "info" },
  user: { label: "普通用户", icon: UserIcon, variant: "soft" },
}

function statusBadge(status?: string): { label: string; variant: React.ComponentProps<typeof Badge>["variant"] } {
  switch (status || "active") {
    case "suspended":
      return { label: "已停用", variant: "warning" }
    case "departed":
      return { label: "已离职", variant: "secondary" }
    case "active":
      return { label: "在职", variant: "success" }
    default:
      return { label: status as string, variant: "outline" }
  }
}

function initials(name: string): string {
  const t = (name || "").trim()
  if (!t) return "?"
  if (/[一-龥]/.test(t[0])) return t[0]
  return t[0].toUpperCase()
}

// ----- page ------------------------------------------------------------------

export default function ProfilePage() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ["me", "profile"], queryFn: meService.profile })
  const access = useQuery({ queryKey: ["me", "access"], queryFn: meService.access })

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">个人资料</h1>
        <p className="text-sm text-muted-foreground">管理你的身份信息与登录密码。用户名与权限由管理员分配。</p>
      </div>

      {me.isLoading || !me.data ? (
        <LoadingState />
      ) : (
        <>
          <IdentityCard user={me.data} tier={access.data?.tier} />

          <Tabs defaultValue="profile">
            <TabsList>
              <TabsTrigger value="profile">基本资料</TabsTrigger>
              <TabsTrigger value="password">修改密码</TabsTrigger>
            </TabsList>

            <TabsContent value="profile" className="mt-4">
              <ProfileForm
                user={me.data}
                onSaved={() => qc.invalidateQueries({ queryKey: ["me", "profile"] })}
              />
            </TabsContent>

            <TabsContent value="password" className="mt-4">
              <PasswordForm />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}

// ----- identity hero ---------------------------------------------------------

function IdentityCard({ user, tier }: { user: User; tier?: AccessTier }) {
  const tierMeta = tier ? TIER_META[tier] : null
  const TierIcon = tierMeta?.icon
  const status = statusBadge(user.status)
  const name = user.display_name || user.username

  return (
    <Card className="gap-0 overflow-hidden p-0">
      {/* Identity band — a soft coral wash so the page opens with warmth. */}
      <div className="bg-gradient-to-br from-primary/[0.07] via-card to-card px-6 py-6">
        <div className="flex items-center gap-4">
          <Avatar className="size-16 ring-2 ring-background">
            <AvatarImage src={user.avatar_url || undefined} alt={name} />
            <AvatarFallback className="bg-primary/15 text-primary text-xl font-semibold">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xl font-semibold truncate">{name}</span>
              {tierMeta && (
                <Badge variant={tierMeta.variant} className="gap-1">
                  {TierIcon && <TierIcon className="size-3" />}
                  {tierMeta.label}
                </Badge>
              )}
              <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
              <AtSign className="size-3.5 shrink-0" />
              {user.username}
            </p>
          </div>
        </div>
      </div>

      {/* Account facts — security-relevant, no overlap with the badges above. */}
      <div className="grid grid-cols-1 divide-y border-t sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Stat
          icon={Clock}
          label="上次登录"
          value={user.last_login_at ? relTime(user.last_login_at) : "暂无记录"}
          sub={user.last_login_at ? user.last_login_ip : undefined}
          hint={user.last_login_at ? fullTime(user.last_login_at) : undefined}
        />
        <Stat
          icon={CalendarDays}
          label="加入时间"
          value={user.created_at ? relTime(user.created_at) : "—"}
          hint={user.created_at ? fullTime(user.created_at) : undefined}
        />
        <Stat
          icon={KeyRound}
          label="密码更新"
          value={user.password_changed ? relTime(user.password_changed) : "从未修改"}
          hint={user.password_changed ? fullTime(user.password_changed) : undefined}
        />
      </div>
    </Card>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
  hint?: string
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium" title={hint}>
          {value}
        </p>
        {sub && <p className="truncate font-mono text-xs text-muted-foreground/80">{sub}</p>}
      </div>
    </div>
  )
}

// ----- basic info form -------------------------------------------------------

function ProfileForm({ user, onSaved }: { user: User; onSaved: () => void }) {
  const [draft, setDraft] = React.useState({
    display_name: user.display_name ?? "",
    email: user.email ?? "",
    phone: user.phone ?? "",
  })

  // Re-sync when the server copy changes (e.g. after a save invalidates it).
  React.useEffect(() => {
    setDraft({
      display_name: user.display_name ?? "",
      email: user.email ?? "",
      phone: user.phone ?? "",
    })
  }, [user.display_name, user.email, user.phone])

  const dirty =
    draft.display_name !== (user.display_name ?? "") ||
    draft.email !== (user.email ?? "") ||
    draft.phone !== (user.phone ?? "")

  const save = useMutation({
    mutationFn: () => meService.updateProfile(draft),
    onSuccess: () => {
      onSaved()
      toast.success("资料已更新")
    },
    onError: (e: unknown) => toast.error("更新失败", { description: (e as Error).message }),
  })

  const reset = () =>
    setDraft({
      display_name: user.display_name ?? "",
      email: user.email ?? "",
      phone: user.phone ?? "",
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle>基本资料</CardTitle>
        <CardDescription>这些信息用于站内展示与重要通知，建议保持邮箱有效。</CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="pf-username">用户名</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <UserIcon />
              </InputGroupAddon>
              <InputGroupInput id="pf-username" value={user.username} readOnly disabled />
              <InputGroupAddon align="inline-end">
                <InputGroupText>
                  <Lock className="size-3.5" /> 不可修改
                </InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>用户名由管理员分配，作为唯一登录标识。</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="pf-display">显示名</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <UserIcon />
              </InputGroupAddon>
              <InputGroupInput
                id="pf-display"
                placeholder="给自己起个好认的名字"
                value={draft.display_name}
                onChange={(e) => setDraft((d) => ({ ...d, display_name: e.target.value }))}
              />
            </InputGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="pf-email">邮箱</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <Mail />
              </InputGroupAddon>
              <InputGroupInput
                id="pf-email"
                type="email"
                placeholder="name@example.com"
                value={draft.email}
                onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
              />
            </InputGroup>
            <FieldDescription>用于接收登录异常、审批等通知。</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="pf-phone">手机号</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <Phone />
              </InputGroupAddon>
              <InputGroupInput
                id="pf-phone"
                placeholder="选填"
                value={draft.phone}
                onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
              />
            </InputGroup>
          </Field>

          <div className="flex items-center gap-2">
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? <Spinner /> : <Save />}
              保存修改
            </Button>
            {dirty && !save.isPending && (
              <Button variant="ghost" onClick={reset}>
                <RotateCcw /> 撤销
              </Button>
            )}
          </div>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}

// ----- password form ---------------------------------------------------------

function scorePassword(pw: string): number {
  if (!pw) return 0
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw)) s++
  return Math.min(s, 4)
}

const STRENGTH = [
  { label: "太弱", tone: "text-destructive" },
  { label: "偏弱", tone: "text-destructive" },
  { label: "一般", tone: "text-warning" },
  { label: "不错", tone: "text-success" },
  { label: "很强", tone: "text-success" },
] as const

function PasswordForm() {
  const [oldPw, setOldPw] = React.useState("")
  const [newPw, setNewPw] = React.useState("")
  const [confirmPw, setConfirmPw] = React.useState("")
  const [showOld, setShowOld] = React.useState(false)
  const [showNew, setShowNew] = React.useState(false)

  const score = scorePassword(newPw)
  const strength = STRENGTH[score]
  const mismatch = confirmPw.length > 0 && newPw !== confirmPw

  const reqs = [
    { ok: newPw.length >= 8, label: "至少 8 个字符" },
    { ok: /[A-Za-z]/.test(newPw) && /\d/.test(newPw), label: "同时包含字母和数字" },
    { ok: /[^A-Za-z0-9]/.test(newPw) || /[A-Z]/.test(newPw), label: "包含大写字母或符号（更安全）" },
  ]

  const canSubmit = oldPw.length > 0 && newPw.length >= 8 && newPw === confirmPw

  const changePw = useMutation({
    mutationFn: () => meService.changePassword(oldPw, newPw),
    onSuccess: () => {
      setOldPw("")
      setNewPw("")
      setConfirmPw("")
      toast.success("密码已修改", { description: "请牢记新密码，下次登录时使用。" })
    },
    onError: (e: unknown) => toast.error("修改失败", { description: (e as Error).message }),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>修改密码</CardTitle>
        <CardDescription>定期更换高强度密码，能有效降低账号被盗的风险。</CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="pw-old">当前密码</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <Lock />
              </InputGroupAddon>
              <InputGroupInput
                id="pw-old"
                type={showOld ? "text" : "password"}
                autoComplete="current-password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={showOld ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowOld((v) => !v)}
                >
                  {showOld ? <EyeOff /> : <Eye />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </Field>

          <Field>
            <FieldLabel htmlFor="pw-new">新密码</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <KeyRound />
              </InputGroupAddon>
              <InputGroupInput
                id="pw-new"
                type={showNew ? "text" : "password"}
                autoComplete="new-password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={showNew ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowNew((v) => !v)}
                >
                  {showNew ? <EyeOff /> : <Eye />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>

            {newPw.length > 0 && (
              <div className="space-y-2 pt-1">
                <div className="flex items-center gap-3">
                  <Progress value={(score / 4) * 100} className="h-1.5" />
                  <span className={cn("text-xs font-medium shrink-0", strength.tone)}>{strength.label}</span>
                </div>
                <ul className="space-y-1">
                  {reqs.map((r) => (
                    <li
                      key={r.label}
                      className={cn(
                        "flex items-center gap-1.5 text-xs",
                        r.ok ? "text-success" : "text-muted-foreground",
                      )}
                    >
                      {r.ok ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
                      {r.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Field>

          <Field data-invalid={mismatch || undefined}>
            <FieldLabel htmlFor="pw-confirm">确认新密码</FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <KeyRound />
              </InputGroupAddon>
              <InputGroupInput
                id="pw-confirm"
                type={showNew ? "text" : "password"}
                autoComplete="new-password"
                aria-invalid={mismatch || undefined}
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
              />
            </InputGroup>
            {mismatch && <FieldDescription className="text-destructive">两次输入的密码不一致。</FieldDescription>}
          </Field>

          <Button onClick={() => changePw.mutate()} disabled={!canSubmit || changePw.isPending}>
            {changePw.isPending ? <Spinner /> : <ShieldCheck />}
            修改密码
          </Button>

          <FieldDescription>
            想用更安全的方式登录？可前往{" "}
            <Link href="/me/security" className="text-primary font-medium hover:underline">
              安全设置
            </Link>{" "}
            启用多因子认证或通行密钥。
          </FieldDescription>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}

// ----- loading ---------------------------------------------------------------

function LoadingState() {
  return (
    <>
      <Card className="gap-0 overflow-hidden p-0">
        <div className="bg-gradient-to-br from-primary/[0.07] via-card to-card px-6 py-6">
          <div className="flex items-center gap-4">
            <Skeleton className="size-16 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-28" />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 divide-y border-t sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-5 py-4">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="space-y-2 pt-0.5">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-4 w-20" />
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Skeleton className="h-9 w-56 rounded-md" />
      <Card>
        <CardContent className="pt-6 space-y-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  )
}
