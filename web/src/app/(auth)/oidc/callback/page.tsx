"use client"

// Phase 13 — OIDC 回调页统一视觉。Card 容器,Badge + 状态指示器,与
// login / mfa 同款外观。

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { motion } from "motion/react"
import { ArrowLeft, CheckCircle2, Loader2, ShieldAlert, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { setTokens } from "@/lib/auth/tokens"
import { toast } from "sonner"

export const dynamic = "force-dynamic"

export default function OIDCCallbackPage() {
  return (
    <React.Suspense fallback={<Fallback />}>
      <Inner />
    </React.Suspense>
  )
}

function PageHeader() {
  return (
    <header className="space-y-2">
      <Badge variant="outline" className="font-normal text-[10px] uppercase tracking-wider">
        <ShieldCheck className="mr-1 h-3 w-3" /> Single Sign-On
      </Badge>
      <h2 className="text-2xl font-semibold tracking-tight">OIDC 登录</h2>
      <p className="text-sm text-muted-foreground">
        正在与身份提供商交换令牌,完成后会自动跳转到控制台。
      </p>
    </header>
  )
}

function Fallback() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 30 }}
      className="space-y-6"
    >
      <PageHeader />
      <Card>
        <CardContent className="flex items-center gap-2 px-6 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在准备…
        </CardContent>
      </Card>
    </motion.div>
  )
}

function Inner() {
  const router = useRouter()
  const params = useSearchParams()
  const provider = params.get("provider")
  const code = params.get("code")
  const state = params.get("state")
  const [err, setErr] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)

  React.useEffect(() => {
    if (!provider || !code || !state) {
      setErr("回调缺少必要参数(provider/code/state)")
      return
    }
    ;(async () => {
      try {
        const url = `/api/proxy/api/v1/auth/oidc/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
        const res = await fetch(url, { credentials: "include" })
        if (!res.ok) {
          const txt = await res.text()
          throw new Error(txt || res.statusText)
        }
        const body = (await res.json()) as { access_token: string; refresh_token?: string }
        if (!body.access_token) throw new Error("响应中没有 access_token")
        setTokens(body.access_token, body.refresh_token)
        setDone(true)
        toast.success("OIDC 登录成功")
        router.replace("/dashboard")
      } catch (e: unknown) {
        setErr((e as Error).message || "OIDC 回调处理失败")
      }
    })()
  }, [provider, code, state, router])

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 30 }}
      className="space-y-6"
    >
      <PageHeader />
      <Card>
        <CardContent className="px-6 py-6">
          {!err ? (
            done ? (
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                登录成功,正在跳转…
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                正在与身份提供商 <span className="font-mono">{provider}</span> 交换令牌…
              </div>
            )
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-destructive">
                <ShieldAlert className="h-4 w-4" />
                <span className="text-sm font-medium">登录失败</span>
              </div>
              <p className="break-all rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {err}
              </p>
              <Button variant="outline" onClick={() => router.replace("/login")}>
                <ArrowLeft className="h-3.5 w-3.5" /> 返回登录
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}
