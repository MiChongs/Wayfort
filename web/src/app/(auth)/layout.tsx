// Phase 13 — 重新设计的 auth shell。两栏布局:
//   - 左侧 brand 侧栏(仅大屏显示),严肃专业 — 不再提 AI、不再用炫目渐变
//   - 右侧滚动容器,内嵌的 page 自己提供 Card / Sheet
//
// 文案聚焦堡垒机 / 远程访问 / 审计 — 与产品本质对齐。

import { Shield, KeyRound, Globe, ServerCog } from "lucide-react"
import { cn } from "@/lib/utils"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      {/* Subtle background grid — pure CSS, no SVG dependency */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 -z-10",
          "[background-image:linear-gradient(to_right,rgba(120,120,120,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(120,120,120,0.06)_1px,transparent_1px)]",
          "[background-size:48px_48px]",
          "[mask-image:radial-gradient(ellipse_at_center,black_25%,transparent_70%)]",
        )}
      />
      <div className="grid min-h-screen lg:grid-cols-[44%_minmax(0,1fr)]">
        <BrandPanel />
        <main className="flex items-center justify-center px-4 py-10 sm:px-8">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  )
}

function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-between border-r bg-card/40 p-12 lg:flex">
      {/* Brand mark */}
      <div className="flex items-center gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background shadow-sm">
          <ServerCog className="h-5 w-5" />
        </span>
        <div className="space-y-0.5">
          <p className="text-base font-semibold tracking-tight">JumpServer</p>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Bastion · 远程访问网关
          </p>
        </div>
      </div>

      {/* Headline + feature list — neutral, professional */}
      <div className="space-y-8">
        <div className="max-w-md space-y-3">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            统一的远程登录入口
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            集中管理服务器、数据库、Windows 桌面,会话全程审计可回放。
            通过浏览器即可访问,无需在本机维护密钥。
          </p>
        </div>
        <ul className="grid gap-3 text-sm">
          <Feature
            icon={Shield}
            title="集中身份"
            desc="MFA / Passkey / OIDC / SAML 单点登录"
          />
          <Feature
            icon={KeyRound}
            title="加密凭据"
            desc="AES-256-GCM 封存,登录密钥永不下发到浏览器"
          />
          <Feature
            icon={Globe}
            title="多协议接入"
            desc="SSH · Telnet · RDP · VNC · MySQL · PostgreSQL · TCP"
          />
          <Feature
            icon={ServerCog}
            title="会话审计"
            desc="终端 asciicast、桌面录屏、命令历史可检索"
          />
        </ul>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>© JumpServer · Open Source</span>
        <span>v2 · MIT License</span>
      </div>
    </aside>
  )
}

function Feature({
  icon: Icon,
  title,
  desc,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
}) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-border/50 bg-background/40 p-3 backdrop-blur-sm">
      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{desc}</p>
      </div>
    </li>
  )
}
