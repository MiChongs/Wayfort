"use client"

// Phase 13 — MFA page redesign. Card + Tabs (TOTP / Email / Recovery).
// 完全 shadcn,无 Dialog 或 alert。视觉与 login 页保持一致(同 Card 容器、
// 同 Badge / 同 Header)。

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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { authService } from "@/lib/api/services"
import { setTokens } from "@/lib/auth/tokens"

const METHOD_LABELS: Record<string, string> = {
  totp: "TOTP",
  email: "邮箱",
  recovery: "恢复码",
}

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

  const defaultTab = methods.includes("totp") ? "totp" : methods[0] || "totp"

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
          请使用您绑定的方式生成或接收验证码。当前账号支持:{" "}
          <span className="font-medium text-foreground">
            {methods.map((m) => METHOD_LABELS[m] || m).join(" / ")}
          </span>
        </p>
      </header>

      <Card className="border-border/60 shadow-sm">
        <CardContent className="p-6">
          <Tabs defaultValue={defaultTab}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="totp" disabled={!methods.includes("totp")}>
                <ShieldCheck className="h-3.5 w-3.5" /> TOTP
              </TabsTrigger>
              <TabsTrigger value="email" disabled={!methods.includes("email")}>
                <Mail className="h-3.5 w-3.5" /> 邮箱
              </TabsTrigger>
              <TabsTrigger value="recovery" disabled={!methods.includes("recovery")}>
                <KeyRound className="h-3.5 w-3.5" /> 恢复码
              </TabsTrigger>
            </TabsList>
            <TabsContent value="totp" className="mt-4">
              <CodeForm
                onSubmit={(c) => submit("totp", c)}
                busy={busy}
                label="6 位 TOTP 验证码"
                hint="在 Authenticator / 1Password / Bitwarden 等应用中查看。"
                length={6}
              />
            </TabsContent>
            <TabsContent value="email" className="mt-4">
              <EmailForm challenge={challenge} onSubmit={(c) => submit("email-otp", c)} busy={busy} />
            </TabsContent>
            <TabsContent value="recovery" className="mt-4">
              <CodeForm
                onSubmit={(c) => submit("recovery", c)}
                busy={busy}
                label="一次性恢复码"
                hint="格式: XXXX-XXXX-XXXX-XXXX 。每个恢复码只能使用一次。"
              />
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

function CodeForm({
  onSubmit,
  busy,
  label,
  hint,
  length,
}: {
  onSubmit: (c: string) => void
  busy: boolean
  label: string
  hint?: string
  length?: number
}) {
  const [code, setCode] = React.useState("")
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (code) onSubmit(code)
      }}
    >
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          maxLength={length}
          inputMode="numeric"
          className="text-center font-mono text-lg tracking-[0.4em]"
        />
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={busy || !code}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        验证并登录
      </Button>
    </form>
  )
}

function EmailForm({
  challenge,
  onSubmit,
  busy,
}: {
  challenge: string
  onSubmit: (c: string) => void
  busy: boolean
}) {
  const [code, setCode] = React.useState("")
  const [sent, setSent] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [coolUntil, setCoolUntil] = React.useState(0)

  async function send() {
    setSending(true)
    try {
      await authService.sendEmailOTP(challenge)
      setSent(true)
      setCoolUntil(Date.now() + 60_000)
      toast.success("验证码已发送", { description: "请检查您绑定邮箱的收件箱" })
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
    <div className="space-y-3">
      <Button variant="outline" onClick={send} className="w-full" disabled={sending || coolLeft > 0}>
        {sending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Mail className="h-4 w-4" />
        )}
        {sent ? (coolLeft > 0 ? `${coolLeft}s 后可重新发送` : "重新发送") : "发送邮箱验证码"}
      </Button>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (code) onSubmit(code)
        }}
      >
        <div className="space-y-1.5">
          <Label>邮件中的 6 位验证码</Label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            maxLength={6}
            className="text-center font-mono text-lg tracking-[0.4em]"
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy || !code}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          验证并登录
        </Button>
      </form>
    </div>
  )
}
