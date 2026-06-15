"use client"

// 登录页 —— Anthropic 风格的极简登录入口。
// 平铺在暖色深底画布上(无 Card),只保留登录必需的元素:
//   用户名 + 密码(显隐 / Caps Lock 提示)+ 记住我 + 登录按钮
//   + Passkey / 单点登录 / 其他登录方式 Sheet。
// 不写营销描述、不堆砌说明 —— 它只是一个登录页。
//
// 标题用 Geist 非衬线(项目铁律)。功能逻辑与旧版保持一致。

import * as React from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "@/components/ui/sonner"
import { useQuery } from "@tanstack/react-query"
import { startAuthentication } from "@simplewebauthn/browser"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  Fingerprint,
  Globe,
  Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { AuthMethodsSheet } from "@/components/auth/auth-methods-sheet"
import { authService } from "@/lib/api/services"
import { setTokens } from "@/lib/auth/tokens"

const schema = z.object({
  username: z.string().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码"),
  remember: z.boolean(),
})

type FormValues = z.infer<typeof schema>

export default function LoginPage() {
  const router = useRouter()
  const reducedMotion = useReducedMotion()
  const [busy, setBusy] = React.useState(false)
  const [showPwd, setShowPwd] = React.useState(false)
  const [capsLock, setCapsLock] = React.useState(false)
  const [methodsOpen, setMethodsOpen] = React.useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: "", password: "", remember: true },
  })

  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: authService.providers,
  })

  // 主表单旁只高亮 1 个 SSO 入口,其余收进 Sheet,保持列可扫读。
  const featuredProvider = providers.data?.providers?.[0]
  const extraProviderCount = Math.max(0, (providers.data?.providers?.length ?? 0) - 1)

  React.useEffect(() => {
    const v = localStorage.getItem("auth:remember")
    if (v != null) form.setValue("remember", v === "1")
    const u = localStorage.getItem("auth:lastUsername")
    if (u) form.setValue("username", u)
  }, [form])

  async function onSubmit(values: FormValues) {
    setBusy(true)
    try {
      const res = await authService.login(values.username, values.password)
      localStorage.setItem("auth:remember", values.remember ? "1" : "0")
      localStorage.setItem("auth:lastUsername", values.username)
      if ("step" in res && res.step === "mfa_required") {
        sessionStorage.setItem("mfa:challenge", res.challenge_token)
        sessionStorage.setItem("mfa:methods", JSON.stringify(res.methods))
        router.push("/mfa")
        return
      }
      if ("access_token" in res) {
        setTokens(res.access_token, res.refresh_token)
        toast.success("欢迎回来", { description: values.username })
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
      const username = form.getValues("username") || undefined
      const begin = await authService.passkeyBegin(username)
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

  // Caps Lock 提示 —— 纯辅助,密码看似正确却报错时帮用户定位。
  const onPwdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false)
  }

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 30 }}
      className="space-y-8"
    >
      <h1 className="text-3xl font-semibold tracking-tight">登录</h1>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="username">用户名</Label>
          <Input
            id="username"
            autoComplete="username"
            autoFocus
            placeholder="admin"
            {...form.register("username")}
          />
          {form.formState.errors.username && (
            <p className="text-[11px] text-destructive">{form.formState.errors.username.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">密码</Label>
            <button
              type="button"
              onClick={() => setMethodsOpen(true)}
              className="text-[11px] text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:text-foreground"
            >
              忘记密码?
            </button>
          </div>
          <div className="relative">
            <Input
              id="password"
              type={showPwd ? "text" : "password"}
              autoComplete="current-password"
              className="pr-10"
              onKeyUp={onPwdKey}
              onKeyDown={onPwdKey}
              {...form.register("password")}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-0.5 top-0.5 h-8 w-8 text-muted-foreground"
              aria-label={showPwd ? "隐藏密码" : "显示密码"}
              onClick={() => setShowPwd((v) => !v)}
              tabIndex={-1}
            >
              {showPwd ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <AnimatePresence>
            {capsLock && (
              <motion.p
                initial={reducedMotion ? false : { opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? undefined : { opacity: 0, y: -2 }}
                className="flex items-center gap-1.5 text-[11px] text-warning"
              >
                <AlertTriangle className="h-3 w-3" />
                Caps Lock 已开启
              </motion.p>
            )}
          </AnimatePresence>
          {form.formState.errors.password && (
            <p className="text-[11px] text-destructive">{form.formState.errors.password.message}</p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="remember" className="cursor-pointer text-sm font-normal text-muted-foreground">
            7 天内保持登录
          </Label>
          <Switch
            id="remember"
            checked={form.watch("remember")}
            onCheckedChange={(v) => form.setValue("remember", v)}
          />
        </div>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          登录
        </Button>
      </form>

      <DividerWithText>或</DividerWithText>

      <div className="grid gap-2.5">
        <Button variant="outline" className="w-full" onClick={tryPasskey} disabled={busy}>
          <Fingerprint className="h-4 w-4" /> 使用 Passkey
        </Button>
        {featuredProvider && (
          <Button variant="outline" className="w-full" asChild>
            <a href={`/api/proxy/api/v1/auth/oidc/${featuredProvider.name}/login`}>
              <Globe className="h-4 w-4" />
              {featuredProvider.display_name || featuredProvider.name}
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          className="w-full text-muted-foreground"
          onClick={() => setMethodsOpen(true)}
        >
          其他登录方式
          {extraProviderCount > 0 && (
            <Badge variant="secondary" className="ml-1 font-normal">
              +{extraProviderCount}
            </Badge>
          )}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      <AuthMethodsSheet open={methodsOpen} onOpenChange={setMethodsOpen} onPasskey={tryPasskey} />
    </motion.div>
  )
}

function DividerWithText({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className="border-t border-border" />
      <span className="absolute inset-0 -top-2.5 flex items-center justify-center">
        <span className="bg-background px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          {children}
        </span>
      </span>
    </div>
  )
}
