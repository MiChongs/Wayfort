"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { startRegistration } from "@simplewebauthn/browser"
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Clock,
  Copy,
  Download,
  Fingerprint,
  KeyRound,
  LifeBuoy,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { meService } from "@/lib/api/services"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { MFADevice, Passkey } from "@/lib/api/types"

const TRANSPORT_LABEL: Record<string, string> = {
  internal: "本机",
  hybrid: "手机",
  usb: "USB 密钥",
  nfc: "NFC",
  ble: "蓝牙",
  cable: "有线",
}
function transportText(t?: string): string {
  if (!t) return "通行密钥"
  const parts = t
    .split(",")
    .map((x) => TRANSPORT_LABEL[x.trim()] || x.trim())
    .filter(Boolean)
  return parts.length ? parts.join(" / ") : "通行密钥"
}

// ============================================================================
export default function SecurityPage() {
  const qc = useQueryClient()
  const mfa = useQuery({ queryKey: ["me", "mfa"], queryFn: meService.mfa.list })
  const passkeys = useQuery({ queryKey: ["me", "passkeys"], queryFn: meService.passkey.list })

  const [totpOpen, setTotpOpen] = React.useState(false)
  const [pkOpen, setPkOpen] = React.useState(false)
  const [codes, setCodes] = React.useState<string[] | null>(null)

  const removeMFA = useMutation({
    mutationFn: (id: number) => meService.mfa.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "mfa"] })
      toast.success("已移除")
    },
    onError: (e: unknown) => toast.error("移除失败", { description: (e as Error).message }),
  })
  const removePasskey = useMutation({
    mutationFn: (id: number) => meService.passkey.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "passkeys"] })
      toast.success("已移除")
    },
    onError: (e: unknown) => toast.error("移除失败", { description: (e as Error).message }),
  })
  const regen = useMutation({
    mutationFn: () => meService.mfa.regenerateRecovery(),
    onSuccess: (r) => setCodes(r.codes),
    onError: (e: unknown) => toast.error("生成失败", { description: (e as Error).message }),
  })

  const mfaDevices = mfa.data?.mfa ?? []
  const pkList = passkeys.data?.passkeys ?? []
  const hasMfa = mfaDevices.some((m) => m.enabled)
  const hasPasskey = pkList.length > 0
  const loading = mfa.isLoading || passkeys.isLoading

  const askRemoveMfa = async (m: MFADevice) => {
    if (await confirmDialog({ title: `移除「${m.display_name}」？`, description: "移除后该验证器将无法再用于登录。", destructive: true }))
      removeMFA.mutate(m.id)
  }
  const askRemovePasskey = async (p: Passkey) => {
    if (await confirmDialog({ title: `移除「${p.display_name}」？`, description: "移除后该通行密钥将无法再用于登录。", destructive: true }))
      removePasskey.mutate(p.id)
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <ShieldCheck className="size-5" /> 安全设置
        </h1>
        <p className="text-sm text-muted-foreground">管理登录验证方式，给账号加上密码之外的第二重保护。</p>
      </div>

      {loading ? (
        <LoadingState />
      ) : (
        <>
          <PostureCard hasMfa={hasMfa} hasPasskey={hasPasskey} mfaCount={mfaDevices.filter((m) => m.enabled).length} pkCount={pkList.length} />

          {/* 验证器 App (TOTP) */}
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle className="text-base font-medium">验证器 App</CardTitle>
                <CardDescription>用 Google Authenticator、1Password 等生成 6 位动态码，登录时输入。</CardDescription>
              </div>
              <Button size="sm" className="shrink-0" onClick={() => setTotpOpen(true)}>
                <Plus className="size-4" /> 添加验证器
              </Button>
            </CardHeader>
            <CardContent className="pb-4">
              {mfaDevices.length === 0 ? (
                <EmptyState icon={Smartphone} title="还没有绑定验证器" description="绑定后，登录时除了密码还要输入动态码。" className="py-8" />
              ) : (
                <ul className="divide-y rounded-lg border">
                  {mfaDevices.map((m) => (
                    <MethodRow
                      key={m.id}
                      icon={Smartphone}
                      name={m.display_name}
                      enabled={m.enabled}
                      enabledText="已启用"
                      pendingText="待验证"
                      sub={`${m.type === "email" ? "邮箱验证码" : "验证器 App"} · ${
                        m.last_used_at ? `上次使用 ${relTime(m.last_used_at)}` : `添加于 ${relTime(m.created_at)}`
                      }`}
                      subTitle={m.last_used_at ? fullTime(m.last_used_at) : fullTime(m.created_at)}
                      onRemove={() => askRemoveMfa(m)}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Passkey */}
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle className="text-base font-medium flex items-center gap-1.5">
                  <Fingerprint className="size-4" /> 通行密钥
                </CardTitle>
                <CardDescription>用 Touch ID、Windows Hello 或硬件密钥，无需密码即可登录。</CardDescription>
              </div>
              <Button size="sm" className="shrink-0" onClick={() => setPkOpen(true)}>
                <Plus className="size-4" /> 添加通行密钥
              </Button>
            </CardHeader>
            <CardContent className="pb-4">
              {pkList.length === 0 ? (
                <EmptyState icon={Fingerprint} title="还没有通行密钥" description="添加后可以一步完成登录，比密码更安全也更省事。" className="py-8" />
              ) : (
                <ul className="divide-y rounded-lg border">
                  {pkList.map((p) => (
                    <MethodRow
                      key={p.id}
                      icon={KeyRound}
                      name={p.display_name}
                      enabled
                      enabledText="可用"
                      sub={`${transportText(p.transports)} · ${
                        p.last_used_at ? `上次使用 ${relTime(p.last_used_at)}` : `添加于 ${relTime(p.created_at)}`
                      }`}
                      subTitle={p.last_used_at ? fullTime(p.last_used_at) : fullTime(p.created_at)}
                      onRemove={() => askRemovePasskey(p)}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* 恢复码 */}
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle className="text-base font-medium flex items-center gap-1.5">
                  <LifeBuoy className="size-4" /> 恢复码
                </CardTitle>
                <CardDescription>当你拿不到验证器（手机丢失等）时，用一次性恢复码登录。每次生成都会作废旧码。</CardDescription>
              </div>
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => regen.mutate()} disabled={regen.isPending}>
                {regen.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                生成恢复码
              </Button>
            </CardHeader>
            <CardContent className="pb-5">
              <p className="text-sm text-muted-foreground">建议在绑定验证器后生成一组恢复码，离线保存在安全的地方。</p>
            </CardContent>
          </Card>
        </>
      )}

      <TotpDialog open={totpOpen} onOpenChange={setTotpOpen} onDone={() => qc.invalidateQueries({ queryKey: ["me", "mfa"] })} />
      <PasskeyDialog open={pkOpen} onOpenChange={setPkOpen} onDone={() => qc.invalidateQueries({ queryKey: ["me", "passkeys"] })} />
      <RecoveryDialog codes={codes} onClose={() => setCodes(null)} />
    </div>
  )
}

// ----- posture --------------------------------------------------------------
function PostureCard({
  hasMfa,
  hasPasskey,
  mfaCount,
  pkCount,
}: {
  hasMfa: boolean
  hasPasskey: boolean
  mfaCount: number
  pkCount: number
}) {
  const secured = hasMfa || hasPasskey
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div
        className={cn(
          "flex items-center gap-4 px-6 py-5",
          secured ? "bg-gradient-to-br from-success/[0.10] via-card to-card" : "bg-gradient-to-br from-warning/[0.12] via-card to-card",
        )}
      >
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-full",
            secured ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
          )}
        >
          {secured ? <ShieldCheck className="size-6" /> : <ShieldAlert className="size-6" />}
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{secured ? "账号已开启多因子保护" : "建议为账号加一层保护"}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {secured
              ? "登录时除了密码，还需要第二重验证，被盗风险大幅降低。"
              : "目前仅用密码登录。绑定验证器或通行密钥，安全性会明显提升。"}
          </p>
        </div>
      </div>
      <ul className="divide-y border-t">
        <CheckRow
          done
          icon={Lock}
          label="登录密码"
          sub="已设置"
          action={
            <Button variant="ghost" size="sm" asChild>
              <Link href={"/me/profile" as Parameters<typeof Link>[0]["href"]}>修改</Link>
            </Button>
          }
        />
        <CheckRow done={hasMfa} icon={Smartphone} label="多因子认证" sub={hasMfa ? `${mfaCount} 个验证器已启用` : "未启用，建议绑定一个验证器"} />
        <CheckRow done={hasPasskey} icon={Fingerprint} label="通行密钥" sub={hasPasskey ? `${pkCount} 个已添加` : "未启用，可实现无密码登录"} />
      </ul>
    </Card>
  )
}

function CheckRow({
  done,
  icon: Icon,
  label,
  sub,
  action,
}: {
  done: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
  sub: string
  action?: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-3 px-6 py-3">
      {done ? (
        <CheckCircle2 className="size-4 shrink-0 text-success" />
      ) : (
        <Circle className="size-4 shrink-0 text-muted-foreground/50" />
      )}
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{sub}</p>
      </div>
      {action}
    </li>
  )
}

// ----- bound method row -----------------------------------------------------
function MethodRow({
  icon: Icon,
  name,
  enabled,
  enabledText,
  pendingText,
  sub,
  subTitle,
  onRemove,
}: {
  icon: React.ComponentType<{ className?: string }>
  name: string
  enabled: boolean
  enabledText: string
  pendingText?: string
  sub: string
  subTitle?: string
  onRemove: () => void
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          <Badge variant={enabled ? "success" : "secondary"} className="shrink-0">
            {enabled ? enabledText : pendingText || "待验证"}
          </Badge>
        </div>
        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground" title={subTitle}>
          <Clock className="size-3 shrink-0" /> {sub}
        </p>
      </div>
      <Button variant="ghost" size="icon" aria-label="移除" className="shrink-0" onClick={onRemove}>
        <Trash2 className="size-4 text-destructive" />
      </Button>
    </li>
  )
}

// ----- TOTP enrollment dialog ----------------------------------------------
function TotpDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [phase, setPhase] = React.useState<"name" | "verify">("name")
  const [name, setName] = React.useState("验证器 App")
  const [pending, setPending] = React.useState<{ mfa_id: number; secret: string; qr: string } | null>(null)
  const [code, setCode] = React.useState("")

  React.useEffect(() => {
    if (!open) {
      setPhase("name")
      setName("验证器 App")
      setPending(null)
      setCode("")
    }
  }, [open])

  const begin = useMutation({
    mutationFn: () => meService.mfa.beginTOTP(name.trim() || "验证器 App"),
    onSuccess: (r) => {
      setPending({ mfa_id: r.mfa_id, secret: r.secret, qr: r.qr_base64 })
      setPhase("verify")
    },
    onError: (e: unknown) => toast.error("无法生成二维码", { description: (e as Error).message }),
  })
  const finish = useMutation({
    mutationFn: () => meService.mfa.finishTOTP(pending!.mfa_id, code),
    onSuccess: () => {
      toast.success("验证器已启用")
      onDone()
      onOpenChange(false)
    },
    onError: (e: unknown) => toast.error("验证码不正确", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加验证器</DialogTitle>
          <DialogDescription>
            {phase === "name" ? "给这个验证器起个名字，方便日后辨认。" : "用验证器 App 扫描二维码，再输入它显示的 6 位动态码。"}
          </DialogDescription>
        </DialogHeader>

        {phase === "name" ? (
          <div className="space-y-1.5">
            <Label htmlFor="totp-name">验证器名称</Label>
            <Input id="totp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：我的手机" autoFocus />
          </div>
        ) : (
          pending && (
            <div className="space-y-4">
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`data:image/png;base64,${pending.qr}`} alt="TOTP 二维码" className="size-44 rounded-lg bg-white p-2" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">不能扫码？手动输入密钥</Label>
                <div className="flex items-center gap-1 rounded-md border bg-muted/40 px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">{pending.secret}</code>
                  <CopyButton value={pending.secret} className="size-6 shrink-0" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-sm">验证器显示的 6 位动态码</Label>
                <div className="flex justify-center py-1">
                  <InputOTP maxLength={6} value={code} onChange={setCode} autoFocus>
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                    </InputOTPGroup>
                    <InputOTPSeparator />
                    <InputOTPGroup>
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              </div>
            </div>
          )
        )}

        <DialogFooter>
          {phase === "name" ? (
            <Button onClick={() => begin.mutate()} disabled={begin.isPending}>
              {begin.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              下一步
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setPhase("name")} disabled={finish.isPending}>
                <ArrowLeft className="size-4" /> 返回
              </Button>
              <Button onClick={() => finish.mutate()} disabled={code.length !== 6 || finish.isPending}>
                {finish.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                启用
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----- passkey registration dialog -----------------------------------------
function PasskeyDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [name, setName] = React.useState("我的通行密钥")
  React.useEffect(() => {
    if (!open) setName("我的通行密钥")
  }, [open])

  const register = useMutation({
    mutationFn: async () => {
      const opts = await meService.passkey.beginRegister(name.trim() || "我的通行密钥")
      const att = await startRegistration(opts.publicKey as never)
      return meService.passkey.finishRegister(att, name.trim() || "我的通行密钥")
    },
    onSuccess: () => {
      toast.success("通行密钥已添加")
      onDone()
      onOpenChange(false)
    },
    onError: (e: unknown) => toast.error("添加失败", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加通行密钥</DialogTitle>
          <DialogDescription>点击「添加」后，按系统提示用指纹、面容或 PIN 完成创建。</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="pk-name">名称</Label>
          <Input id="pk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：MacBook Touch ID" autoFocus />
          <p className="text-xs text-muted-foreground">给它起个能认出设备的名字。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={register.isPending}>
            取消
          </Button>
          <Button onClick={() => register.mutate()} disabled={register.isPending}>
            {register.isPending ? <Loader2 className="size-4 animate-spin" /> : <Fingerprint className="size-4" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----- recovery codes dialog -----------------------------------------------
function RecoveryDialog({ codes, onClose }: { codes: string[] | null; onClose: () => void }) {
  const copyAll = async () => {
    if (!codes) return
    try {
      await navigator.clipboard.writeText(codes.join("\n"))
      toast.success("已复制全部恢复码")
    } catch {
      toast.error("复制失败")
    }
  }
  const download = () => {
    if (!codes) return
    const blob = new Blob([codes.join("\n") + "\n"], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "jumpserver-recovery-codes.txt"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }

  return (
    <Dialog open={!!codes} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>请保存你的恢复码</DialogTitle>
          <DialogDescription>这 10 个一次性恢复码只会显示这一次，每个用一次后失效。</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          离开此窗口后将无法再次查看。请立刻复制或下载，离线保存在安全的地方。
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm">
          {(codes ?? []).map((c) => (
            <div key={c} className="tabular-nums">
              {c}
            </div>
          ))}
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={copyAll}>
              <Copy className="size-4" /> 复制全部
            </Button>
            <Button variant="outline" size="sm" onClick={download}>
              <Download className="size-4" /> 下载
            </Button>
          </div>
          <Button size="sm" onClick={onClose}>
            <CheckCircle2 className="size-4" /> 我已保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----- loading --------------------------------------------------------------
function LoadingState() {
  return (
    <>
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-4 px-6 py-5">
          <Skeleton className="size-12 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <ul className="divide-y border-t">
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-6 py-3">
              <Skeleton className="size-4 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-40" />
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 py-5">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </CardContent>
        </Card>
      ))}
    </>
  )
}
