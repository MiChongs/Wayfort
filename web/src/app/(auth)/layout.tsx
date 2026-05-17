import { Server } from "lucide-react"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex w-1/2 bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900 text-zinc-100 p-12 flex-col justify-between">
        <div className="flex items-center gap-3">
          <Server className="w-8 h-8" />
          <span className="text-xl font-semibold tracking-tight">JumpServer Anonymous</span>
        </div>
        <div>
          <h1 className="text-3xl font-semibold leading-tight">现代化网页跳板机</h1>
          <p className="mt-3 text-zinc-300 leading-relaxed">
            SSH / Telnet / RDP / VNC / 数据库 CLI / TCP 转发 + AI 运维助手，全部在浏览器里。
          </p>
          <ul className="mt-8 space-y-2 text-sm text-zinc-400">
            <li>✓ 多级代理链：直连 / SOCKS5 / SSH 跳板</li>
            <li>✓ MFA + Passkey + OIDC</li>
            <li>✓ AI 助手对话化运维（OpenAI / Claude / Gemini / 兼容网关）</li>
            <li>✓ 完整审计 + 会话录像</li>
          </ul>
        </div>
        <div className="text-xs text-zinc-500">© JumpServer Anonymous · MIT License</div>
      </div>
      <div className="flex-1 flex items-center justify-center p-6 bg-background">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  )
}
