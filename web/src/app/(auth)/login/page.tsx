"use client"

// Phase 13 — Login page redesign.
//
// Layout:
//   - Card 容器,大字号问候 + 表单
//   - 用户名 + 密码 + "记住我"(7d refresh)+ 显示密码切换 + Caps Lock 提示
//   - 主按钮 + Passkey 二级按钮 + "其他登录方式" Sheet 触发
//   - OIDC providers 在 Sheet 内分组,主表单只显示 ≤1 个高亮入口
//
// 设计纪律:
//   - 不出现 AI / 助手 / 智能 措辞
//   - 全 shadcn primitives,0 raw button / 0 native confirm
//   - 大布局表单 / 选择 → Sheet,不用 Dialog

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
  LogIn,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { AuthMethodsSheet } from "@/components/auth/auth-methods-sheet"
import { authService } from "@/lib/api/services"
import { setTokens } from "@/lib/auth/tokens"
import { cn } from "@/lib/utils"

const schema = z.object({
  username: z.string().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码"),
  // 必填 + 由 useForm.defaultValues 提供初值。原写法
  //   z.boolean().optional().default(true)
  // 让 zod 的 input/output 类型分裂（input 可空，output 必填），
  // 新版 @hookform/resolvers 严格校验后导致 Resolver / SubmitHandler
  // 类型推断失配。改成必填即可对齐两端。
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

  // The featured SSO entry rendered next to the password form. Keeps the
  // main column scannable when many providers exist; the full list lives
  // in the AuthMethods Sheet.
  const featuredProvider = providers.data?.providers?.[0]
  const extraProviderCount = Math.max(0, (providers.data?.providers?.length ?? 0) - 1)

  React.useEffect(() => {
    // Hydrate remember-me from last session
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

  // Caps Lock indicator on the password field — pure cosmetic, helps the
  // user when they're getting "wrong password" with seemingly correct input.
  const onPwdKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false)
  }

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 30 }}
      className="space-y-6"
    >
      <header className="space-y-2">
        <Badge variant="outline" className="font-normal text-[10px] uppercase tracking-wider">
          <ShieldCheck className="mr-1 h-3 w-3" /> Secure Sign In
        </Badge>
        <h2 className="text-2xl font-semibold tracking-tight">登录控制台</h2>
        <p className="text-sm text-muted-foreground">
          使用账号 + 密码登录;如启用了 MFA,系统会在密码之后引导二次验证。
        </p>
      </header>

      <Card className="border-border/60 shadow-sm">
        <CardContent className="space-y-4 p-6">
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
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
                  className="text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
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
                    className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400"
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

            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
              <Label htmlFor="remember" className="cursor-pointer text-sm">
                7 天内保持登录
              </Label>
              <Switch
                id="remember"
                checked={form.watch("remember")}
                onCheckedChange={(v) => form.setValue("remember", v)}
              />
            </div>

            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              登录
            </Button>
          </form>

          <DividerWithText>或</DividerWithText>

          <div className="grid gap-2">
            <Button variant="outline" className="w-full" onClick={tryPasskey} disabled={busy}>
              <Fingerprint className="h-4 w-4" /> 使用 Passkey
            </Button>
            {featuredProvider && (
              <Button
                variant="outline"
                className="w-full"
                asChild
              >
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
        </CardContent>
      </Card>

      <p className="text-center text-[11px] text-muted-foreground">
        通过登录即表示您同意所属组织的远程访问与审计策略。
      </p>

      <AuthMethodsSheet
        open={methodsOpen}
        onOpenChange={setMethodsOpen}
        onPasskey={tryPasskey}
      />
    </motion.div>
  )
}

function DividerWithText({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn("relative")}>
      <Separator />
      <span className="absolute inset-0 -top-2.5 flex items-center justify-center">
        <span className="bg-card px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          {children}
        </span>
      </span>
    </div>
  )
}
