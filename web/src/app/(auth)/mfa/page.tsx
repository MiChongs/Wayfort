"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authService } from "@/lib/api/services"
import { setTokens } from "@/lib/auth/tokens"

export default function MfaPage() {
  const router = useRouter()
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
      const fn = method === "totp"
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
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">二次验证</h2>
        <p className="mt-2 text-sm text-muted-foreground">请输入您绑定的 MFA 验证码完成登录。</p>
      </div>
      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="totp" disabled={!methods.includes("totp")}>TOTP</TabsTrigger>
          <TabsTrigger value="email" disabled={!methods.includes("email")}>邮箱</TabsTrigger>
          <TabsTrigger value="recovery" disabled={!methods.includes("recovery")}>恢复码</TabsTrigger>
        </TabsList>
        <TabsContent value="totp">
          <CodeForm onSubmit={(c) => submit("totp", c)} busy={busy} label="6 位 TOTP 验证码" />
        </TabsContent>
        <TabsContent value="email">
          <EmailForm challenge={challenge} onSubmit={(c) => submit("email-otp", c)} busy={busy} />
        </TabsContent>
        <TabsContent value="recovery">
          <CodeForm onSubmit={(c) => submit("recovery", c)} busy={busy} label="一次性恢复码（XXXX-XXXX-XXXX-XXXX）" />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function CodeForm({ onSubmit, busy, label }: { onSubmit: (c: string) => void; busy: boolean; label: string }) {
  const [code, setCode] = React.useState("")
  return (
    <form
      className="space-y-3 mt-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (code) onSubmit(code)
      }}
    >
      <Label>{label}</Label>
      <Input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" />
      <Button type="submit" className="w-full" disabled={busy || !code}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        验证并登录
      </Button>
    </form>
  )
}

function EmailForm({ challenge, onSubmit, busy }: { challenge: string; onSubmit: (c: string) => void; busy: boolean }) {
  const [code, setCode] = React.useState("")
  const [sent, setSent] = React.useState(false)
  async function send() {
    try {
      await authService.sendEmailOTP(challenge)
      setSent(true)
      toast.success("验证码已发送到您绑定的邮箱")
    } catch (e: unknown) {
      const err = e as { message?: string }
      toast.error("发送失败", { description: err.message })
    }
  }
  return (
    <div className="space-y-3 mt-4">
      <Button variant="outline" onClick={send} className="w-full">
        {sent ? "重新发送" : "发送邮箱验证码"}
      </Button>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (code) onSubmit(code)
        }}
      >
        <Label>邮箱中的 6 位验证码</Label>
        <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" />
        <Button type="submit" className="w-full" disabled={busy || !code}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          验证并登录
        </Button>
      </form>
    </div>
  )
}
