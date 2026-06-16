"use client"

// 二次验证页：Card + 仅渲染账号实际支持的方式。验证码用分段 InputOTP(输满自动
// 提交),恢复码用等宽输入。完全 shadcn,视觉与 login 页一致。

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "@/components/ui/sonner"
import { motion, useReducedMotion } from "motion/react"
import { ArrowLeft, KeyRound, Loader2, Mail, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"
import { authService } from "@/lib/api/services"
import { setTokens } from "@/lib/auth/tokens"
import { cn } from "@/lib/utils"

const METHOD_LABELS: Record<string, string> = {
  totp: "验证器",
  email: "邮箱验证码",
  recovery: "恢复码",
}

const TAB_CONFIG = [
  { value: "totp", label: "验证器", icon: ShieldCheck },
  { value: "email", label: "邮箱", icon: Mail },
  { value: "recovery", label: "恢复码", icon: KeyRound },
] as const

export default function MfaPage() {
  const router = useRouter()
  const reducedMotion = useReducedMotion()
  const [challenge, setChallenge] = React.useState<string | null>(null)
  const [methods, setMethods] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const c = sessionStorage.getItem("mfa:challenge")
    const m = sessionStorage.getItem("mfa:methods")
    if (!c) {
      router.replace("/login")
      return
    }
    setChallenge(c)
    setMethods(m ? JSON.parse(m) : ["totp"])
  }, [router])

  async function submit(method: "totp" | "email-otp" | "recovery", code: string) {
    if (!challenge) return
    setBusy(true)
    try {
      const fn =
        method === "totp"
          ? authService.loginTOTP
          : method === "email-otp"
            ? authService.loginEmailOTP
            : authService.loginRecovery
      const res = await fn(challenge, code)
      setTokens(res.access_token, res.refresh_token)
      sessionStorage.removeItem("mfa:challenge")
      sessionStorage.removeItem("mfa:methods")
      toast.success("验证通过")
      router.push("/dashboard")
    } catch (e: unknown) {
      const err = e as { message?: string }
      toast.error("验证失败", { description: err.message })
    } finally {
      setBusy(false)
    }
  }

  if (!challenge) return null

  const tabs = TAB_CONFIG.filter((t) => methods.includes(t.value))
  const visible = tabs.length ? tabs : [TAB_CONFIG[0]]
  const defaultTab = methods.includes("totp") ? "totp" : visible[0].value
  const multi = visible.length > 1

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 30 }}
      className="space-y-6"
    >
      <header className="space-y-2">
        <Badge variant="outline" className="font-normal text-[10px] uppercase tracking-wider">
          <ShieldCheck className="mr-1 h-3 w-3" /> Two-Factor
        </Badge>
        <h2 className="text-2xl font-semibold tracking-tight">二次验证</h2>
        <p className="text-sm text-muted-foreground">
          为保护你的账号，请用绑定的{" "}
          <span className="font-medium text-foreground">{methods.map((m) => METHOD_LABELS[m] || m).join(" / ")}</span>{" "}
          完成验证。
        </p>
      </header>

      <Card className="border-border/60 shadow-sm">
        <CardContent className="p-6">
          <Tabs defaultValue={defaultTab}>
            {multi && (
              <TabsList className={cn("grid w-full", visible.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
                {visible.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>
                    <t.icon className="h-3.5 w-3.5" /> {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}

            <TabsContent value="totp" className={cn(multi && "mt-5")}>
              <OtpForm
                onSubmit={(c) => submit("totp", c)}
                busy={busy}
                label="输入验证器 App 显示的 6 位动态码"
                hint="在 Authenticator / 1Password / Bitwarden 等应用中查看。"
              />
            </TabsContent>
            <TabsContent value="email" className={cn(multi && "mt-5")}>
              <EmailForm challenge={challenge} onSubmit={(c) => submit("email-otp", c)} busy={busy} />
            </TabsContent>
            <TabsContent value="recovery" className={cn(multi && "mt-5")}>
              <RecoveryForm onSubmit={(c) => submit("recovery", c)} busy={busy} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Button
        variant="ghost"
        size="sm"
        className="mx-auto flex text-muted-foreground"
        onClick={() => {
          sessionStorage.removeItem("mfa:challenge")
          sessionStorage.removeItem("mfa:methods")
          router.replace("/login")
        }}
      >
        <ArrowLeft className="h-3.5 w-3.5" /> 返回登录
      </Button>
    </motion.div>
  )
}

// Segmented 6-digit code entry. Auto-submits the moment all six are filled, so
// the common path is "type the code, done" — no reaching for a button.
function OtpForm({
  onSubmit,
  busy,
  label,
  hint,
}: {
  onSubmit: (c: string) => void
  busy: boolean
  label: string
  hint?: string
}) {
  const [code, setCode] = React.useState("")
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (code.length === 6 && !busy) onSubmit(code)
      }}
    >
      <div className="space-y-2.5">
        <Label className="block text-center text-xs font-normal text-muted-foreground">{label}</Label>
        <div className="flex justify-center">
          <InputOTP
            maxLength={6}
            value={code}
            autoFocus
            disabled={busy}
            onChange={(v) => {
              setCode(v)
              if (v.length === 6 && !busy) onSubmit(v)
            }}
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} className="size-12 text-lg" />
              <InputOTPSlot index={1} className="size-12 text-lg" />
              <InputOTPSlot index={2} className="size-12 text-lg" />
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              <InputOTPSlot index={3} className="size-12 text-lg" />
              <InputOTPSlot index={4} className="size-12 text-lg" />
              <InputOTPSlot index={5} className="size-12 text-lg" />
            </InputOTPGroup>
          </InputOTP>
        </div>
        {hint && <p className="text-center text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        验证并登录
      </Button>
    </form>
  )
}

function RecoveryForm({ onSubmit, busy }: { onSubmit: (c: string) => void; busy: boolean }) {
  const [code, setCode] = React.useState("")
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (code.trim()) onSubmit(code.trim())
      }}
    >
      <div className="space-y-1.5">
        <Label>一次性恢复码</Label>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="text-center font-mono tracking-widest uppercase"
        />
        <p className="text-[11px] text-muted-foreground">绑定验证器时保存的恢复码，每个只能使用一次。</p>
      </div>
      <Button type="submit" className="w-full" disabled={busy || !code.trim()}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        验证并登录
      </Button>
    </form>
  )
}

function EmailForm({ challenge, onSubmit, busy }: { challenge: string; onSubmit: (c: string) => void; busy: boolean }) {
  const [sent, setSent] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [coolUntil, setCoolUntil] = React.useState(0)

  async function send() {
    setSending(true)
    try {
      await authService.sendEmailOTP(challenge)
      setSent(true)
      setCoolUntil(Date.now() + 60_000)
      toast.success("验证码已发送", { description: "请检查你绑定邮箱的收件箱" })
    } catch (e: unknown) {
      const err = e as { message?: string }
      toast.error("发送失败", { description: err.message })
    } finally {
      setSending(false)
    }
  }

  // Resend cooldown timer.
  const [, force] = React.useState(0)
  React.useEffect(() => {
    if (coolUntil <= Date.now()) return
    const t = setInterval(() => force((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [coolUntil])
  const coolLeft = Math.max(0, Math.ceil((coolUntil - Date.now()) / 1000))

  return (
    <div className="space-y-4">
      <Button variant="outline" onClick={send} className="w-full" disabled={sending || coolLeft > 0}>
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
        {sent ? (coolLeft > 0 ? `${coolLeft}s 后可重新发送` : "重新发送验证码") : "发送邮箱验证码"}
      </Button>
      <OtpForm
        onSubmit={onSubmit}
        busy={busy}
        label="输入邮件中的 6 位验证码"
        hint={sent ? undefined : "点击上方按钮，验证码会发到你绑定的邮箱。"}
      />
    </div>
  )
}
