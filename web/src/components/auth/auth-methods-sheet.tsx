"use client"

// Phase 13 — 登录方式 Sheet。把所有可选登录通道集中介绍 + 一键触发。
// 取代 "弹 Dialog 列方式" 的传统模式,大表单走 Sheet。
//
// 不引入任何 AI 语境;专注堡垒机 / 安全访问。

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { motion } from "motion/react"
import {
  ChevronRight,
  Fingerprint,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { authService } from "@/lib/api/services"

export interface AuthMethodsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the user picks Passkey from the sheet. */
  onPasskey: () => void
  /** Called when the user picks Anonymous mode (returns to login + triggers). */
  onAnonymous?: () => void
}

export function AuthMethodsSheet({
  open,
  onOpenChange,
  onPasskey,
  onAnonymous,
}: AuthMethodsSheetProps) {
  const providers = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: authService.providers,
    enabled: open,
  })
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-6 pt-6 pb-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" /> 选择登录方式
          </SheetTitle>
          <SheetDescription>
            根据账号的身份配置,以下方式都可以完成登录。点击直接触发或前往对应入口。
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          <div className="space-y-3">
            <Group title="本地账号">
              <Method
                icon={Lock}
                title="密码登录"
                desc="输入用户名密码,如启用 MFA 会进入二次验证。"
                badge="主入口"
                onClick={() => onOpenChange(false)}
              />
              <Method
                icon={Fingerprint}
                title="Passkey / 生物识别"
                desc="WebAuthn 平台认证器 — Touch ID / Windows Hello / 安全密钥。"
                badge="无密码"
                onClick={() => {
                  onOpenChange(false)
                  onPasskey()
                }}
              />
            </Group>

            <Group title="第三方身份">
              {providers.isLoading ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 查询身份提供商...
                </div>
              ) : (providers.data?.providers?.length ?? 0) === 0 ? (
                <div className="rounded-md border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                  当前部署未配置 OIDC / SAML 单点登录。管理员可在 OIDC 客户端中接入企业身份源。
                </div>
              ) : (
                providers.data!.providers.map((p) => (
                  <Method
                    key={p.name}
                    icon={Globe}
                    title={p.display_name || p.name}
                    desc={`通过 ${p.display_name || p.name} 单点登录`}
                    badge="SSO"
                    href={`/api/proxy/api/v1/auth/oidc/${p.name}/login`}
                  />
                ))
              )}
            </Group>

            {onAnonymous && (
              <Group title="临时访问">
                <Method
                  icon={Users}
                  title="匿名沙箱"
                  desc="无需账号即可进入只读 / 只执行预设命令的临时容器。"
                  badge="只读"
                  onClick={() => {
                    onOpenChange(false)
                    onAnonymous()
                  }}
                />
              </Group>
            )}

            <Separator />
            <div className="rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">
                <KeyRound className="mr-1 inline h-3 w-3" />
                忘记密码 / 找不到 MFA?
              </p>
              <p>
                请联系管理员重置;管理员可在 “用户” 管理页面里清除 MFA 绑定,
                并通过邮件下发临时密码。
              </p>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function Group({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Method({
  icon: Icon,
  title,
  desc,
  badge,
  onClick,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
  badge?: string
  onClick?: () => void
  href?: string
}) {
  const inner = (
    <>
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-background">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {badge && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
              {badge}
            </Badge>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{desc}</p>
      </div>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
    </>
  )
  const cls = cn(
    "group flex w-full items-start gap-3 rounded-md border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/40",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  )
  if (href) {
    return (
      <motion.a
        whileHover={{ x: 2 }}
        transition={{ type: "spring", stiffness: 320, damping: 26 }}
        href={href}
        className={cls}
      >
        {inner}
      </motion.a>
    )
  }
  return (
    <motion.button
      type="button"
      whileHover={{ x: 2 }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      onClick={onClick}
      className={cls}
    >
      {inner}
    </motion.button>
  )
}

void Button
