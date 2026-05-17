"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { setTokens } from "@/lib/auth/tokens"
import { toast } from "sonner"

export const dynamic = "force-dynamic"

// The backend's OIDC callback handler returns a JSON token pair via
// /auth/oidc/:provider/callback. When the IdP redirects the browser to that
// URL the browser sees a JSON body — which is unfriendly. We solve that by
// telling Keycloak/etc to point its redirect URI at THIS page, which then
// re-POSTs the {code,state} pair through our REST proxy and stores the tokens.

export default function OIDCCallbackPage() {
  return (
    <React.Suspense fallback={<Fallback />}>
      <Inner />
    </React.Suspense>
  )
}

function Fallback() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">OIDC 登录</h2>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        正在准备…
      </div>
    </div>
  )
}

function Inner() {
  const router = useRouter()
  const params = useSearchParams()
  const provider = params.get("provider")
  const code = params.get("code")
  const state = params.get("state")
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!provider || !code || !state) {
      setErr("回调缺少必要参数（provider/code/state）")
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
        toast.success("OIDC 登录成功")
        router.replace("/dashboard")
      } catch (e: unknown) {
        setErr((e as Error).message || "OIDC 回调处理失败")
      }
    })()
  }, [provider, code, state, router])

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">OIDC 登录</h2>
      {!err ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          正在与身份提供商交换令牌…
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="w-4 h-4" /> 登录失败
          </div>
          <p className="text-sm text-muted-foreground break-all">{err}</p>
          <Button variant="outline" onClick={() => router.replace("/login")}>返回登录</Button>
        </div>
      )}
    </div>
  )
}
