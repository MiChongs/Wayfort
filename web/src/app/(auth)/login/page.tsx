"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Fingerprint, Loader2, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { authService } from "@/lib/api/services"
import { setTokens } from "@/lib/auth/tokens"
import { useQuery } from "@tanstack/react-query"
import { startAuthentication } from "@simplewebauthn/browser"

const schema = z.object({
  username: z.string().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码"),
})

type FormValues = z.infer<typeof schema>

export default function LoginPage() {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: "", password: "" },
  })

  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: authService.providers,
  })

  async function onSubmit(values: FormValues) {
    setBusy(true)
    try {
      const res = await authService.login(values.username, values.password)
      if ("step" in res && res.step === "mfa_required") {
        sessionStorage.setItem("mfa:challenge", res.challenge_token)
        sessionStorage.setItem("mfa:methods", JSON.stringify(res.methods))
        router.push("/mfa")
        return
      }
      if ("access_token" in res) {
        setTokens(res.access_token, res.refresh_token)
        toast.success("登录成功")
        router.push("/dashboard")
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      toast.error("登录失败", { description: err.message })
    } finally {
      setBusy(false)
    }
  }

  async function tryPasskey() {
    setBusy(true)
    try {
      const begin = await authService.passkeyBegin(form.getValues("username") || undefined)
      const assertion = await startAuthentication(begin.options.publicKey as never)
      const res = await authService.passkeyFinish(begin.challenge_id, assertion)
      setTokens(res.access_token, res.refresh_token)
      toast.success("Passkey 登录成功")
      router.push("/dashboard")
    } catch (e: unknown) {
      const err = e as { message?: string }
      toast.error("Passkey 登录失败", { description: err.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">登录</h2>
        <p className="mt-2 text-sm text-muted-foreground">使用账号密码、Passkey 或单点登录进入控制台。</p>
      </div>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="username">用户名</Label>
          <Input id="username" autoComplete="username" {...form.register("username")} />
          {form.formState.errors.username && (
            <p className="text-xs text-destructive">{form.formState.errors.username.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">密码</Label>
          <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} />
          {form.formState.errors.password && (
            <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
          登录
        </Button>
      </form>
      <div className="relative">
        <Separator />
        <span className="absolute inset-0 -top-2 flex items-center justify-center">
          <span className="bg-background px-2 text-xs text-muted-foreground">或</span>
        </span>
      </div>
      <Button variant="outline" className="w-full" onClick={tryPasskey} disabled={busy}>
        <Fingerprint className="w-4 h-4" />
        使用 Passkey 登录
      </Button>
      {providers.data?.providers && providers.data.providers.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground text-center">第三方登录</div>
          <div className="flex flex-col gap-2">
            {providers.data.providers.map((p) => (
              <a
                key={p.name}
                href={`/api/proxy/api/v1/auth/oidc/${p.name}/login`}
                className="inline-flex items-center justify-center h-9 px-4 rounded-md border text-sm hover:bg-accent transition-colors"
              >
                {p.display_name || p.name}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
