"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { startRegistration } from "@simplewebauthn/browser"
import { Fingerprint, Plus, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { meService } from "@/lib/api/services"

export default function SecurityPage() {
  const qc = useQueryClient()
  const mfa = useQuery({ queryKey: ["me", "mfa"], queryFn: meService.mfa.list })
  const passkeys = useQuery({ queryKey: ["me", "passkeys"], queryFn: meService.passkey.list })

  // ---- TOTP enrolment ----
  const [name, setName] = React.useState("Authenticator")
  const [pending, setPending] = React.useState<{ mfa_id: number; otpauth: string; qr: string; secret: string } | null>(null)
  const [code, setCode] = React.useState("")
  const begin = useMutation({
    mutationFn: () => meService.mfa.beginTOTP(name),
    onSuccess: (r) => setPending({ mfa_id: r.mfa_id, otpauth: r.otpauth_uri, qr: r.qr_base64, secret: r.secret }),
  })
  const finish = useMutation({
    mutationFn: () => meService.mfa.finishTOTP(pending!.mfa_id, code),
    onSuccess: () => { setPending(null); setCode(""); qc.invalidateQueries({ queryKey: ["me", "mfa"] }); toast.success("TOTP 已启用") },
    onError: (e: unknown) => toast.error("验证失败", { description: (e as Error).message }),
  })
  const removeMFA = useMutation({
    mutationFn: (id: number) => meService.mfa.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "mfa"] }),
  })

  // ---- Recovery codes ----
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const regen = useMutation({
    mutationFn: () => meService.mfa.regenerateRecovery(),
    onSuccess: (r) => { setCodes(r.codes); toast.success("已生成 10 个一次性恢复码，请妥善保存") },
  })

  // ---- Passkey ----
  const [pkName, setPkName] = React.useState("Passkey")
  const registerPasskey = useMutation({
    mutationFn: async () => {
      const opts = await meService.passkey.beginRegister(pkName)
      const att = await startRegistration(opts.publicKey as never)
      return meService.passkey.finishRegister(att, pkName)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["me", "passkeys"] }); toast.success("已注册 Passkey") },
    onError: (e: unknown) => toast.error("注册失败", { description: (e as Error).message }),
  })
  const removePasskey = useMutation({
    mutationFn: (id: number) => meService.passkey.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "passkeys"] }),
  })

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
        <ShieldCheck className="w-5 h-5" /> 安全设置
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>多因子认证</CardTitle>
          <CardDescription>建议绑定 TOTP 或 Passkey 后再生成恢复码备用</CardDescription>
        </CardHeader>
        <CardContent className="pb-6 space-y-4">
          <ul className="divide-y rounded-md border">
            {(mfa.data?.mfa || []).map((m) => (
              <li key={m.id} className="flex items-center justify-between px-3 py-2">
                <div>
                  <div className="text-sm font-medium">{m.display_name}</div>
                  <div className="text-xs text-muted-foreground">{m.type} · {m.enabled ? "已启用" : "未启用"}</div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => removeMFA.mutate(m.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </li>
            ))}
            {(mfa.data?.mfa?.length ?? 0) === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">还没绑定 MFA</li>}
          </ul>

          {pending ? (
            <div className="rounded-md border p-3 space-y-3">
              <div className="text-sm">用 Authenticator 扫描二维码：</div>
              <img src={`data:image/png;base64,${pending.qr}`} alt="QR" className="w-40 h-40 bg-white p-2 rounded" />
              <div className="text-xs text-muted-foreground break-all">
                <div>密钥：<code className="font-mono">{pending.secret}</code></div>
                <div>URI：<code className="font-mono">{pending.otpauth}</code></div>
              </div>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入 6 位 OTP" />
              <div className="flex gap-2">
                <Button onClick={() => finish.mutate()} disabled={code.length !== 6 || finish.isPending}>启用</Button>
                <Button variant="ghost" onClick={() => setPending(null)}>取消</Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2 items-center">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="设备名" className="max-w-xs" />
              <Button onClick={() => begin.mutate()} disabled={begin.isPending}>
                <Plus className="w-4 h-4" /> 绑定 TOTP
              </Button>
              <Button variant="outline" onClick={() => regen.mutate()} disabled={regen.isPending}>
                重新生成恢复码
              </Button>
            </div>
          )}
          {codes && (
            <div className="rounded-md border bg-amber-500/10 p-3">
              <div className="text-sm font-medium mb-2">这 10 个一次性恢复码只显示一次：</div>
              <div className="grid grid-cols-2 gap-2 font-mono text-sm">
                {codes.map((c) => <div key={c}>{c}</div>)}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Fingerprint className="w-5 h-5" /> Passkey（WebAuthn）</CardTitle>
          <CardDescription>支持 Touch ID / Windows Hello / 硬件密钥，绑定后可无密码登录</CardDescription>
        </CardHeader>
        <CardContent className="pb-6 space-y-3">
          <ul className="divide-y rounded-md border">
            {(passkeys.data?.passkeys || []).map((p) => (
              <li key={p.id} className="flex items-center justify-between px-3 py-2">
                <div>
                  <div className="text-sm font-medium">{p.display_name}</div>
                  <div className="text-xs text-muted-foreground">{p.transports || "—"}</div>
                </div>
                <Badge variant="outline">sig {p.sign_count}</Badge>
                <Button variant="ghost" size="icon" onClick={() => removePasskey.mutate(p.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </li>
            ))}
            {(passkeys.data?.passkeys?.length ?? 0) === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">还没绑定 Passkey</li>}
          </ul>
          <div className="flex gap-2 items-center">
            <Input value={pkName} onChange={(e) => setPkName(e.target.value)} placeholder="Passkey 名称" className="max-w-xs" />
            <Button onClick={() => registerPasskey.mutate()} disabled={registerPasskey.isPending}>
              <Fingerprint className="w-4 h-4" /> 注册 Passkey
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
