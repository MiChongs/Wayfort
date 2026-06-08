"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { LogOut, Menu, Moon, Search, Sun, User as UserIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useHotkeys } from "react-hotkeys-hook"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Sidebar } from "@/components/app-shell/sidebar"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { useAccess } from "@/lib/hooks/use-access"
import { authService } from "@/lib/api/services"
import { clearTokens } from "@/lib/auth/tokens"

const PATH_LABELS: Record<string, string> = {
  "/dashboard": "总览",
  "/nodes": "节点",
  "/sessions": "会话历史",
  "/port-forwards": "端口转发",
  "/ai": "AI 助手",
  "/me/profile": "个人资料",
  "/me/security": "安全设置",
  "/me/login-history": "登录历史",
  "/admin/users": "用户管理",
  "/admin/roles": "角色与权限",
  "/admin/organization": "组织架构",
  "/admin/nodes": "资产",
  "/admin/credentials": "凭据",
  "/admin/proxy-center": "代理链中心",
  "/admin/tags": "标签",
  "/admin/asset-grants": "资产授权",
  "/admin/oidc-clients": "OIDC 客户端",
  "/admin/ai/providers": "AI 提供商",
  "/admin/ai/agents": "AI Agent",
  "/admin/ai/usage": "AI 用量",
  "/admin/audit": "审计日志",
}

export function TopBar({
  onMobileMenu, mobileOpen, onMobileClose,
}: {
  onMobileMenu?: () => void
  mobileOpen?: boolean
  onMobileClose?: () => void
}) {
  const router = useRouter()
  const pathname = usePathname()
  const me = useCurrentUser()
  const { tier } = useAccess()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  // Title derived from URL — handles `/nodes/[id]/ssh` etc by trimming
  // unknown suffixes to the closest known prefix.
  const title = React.useMemo(() => {
    if (PATH_LABELS[pathname]) return PATH_LABELS[pathname]
    const parts = pathname.split("/").filter(Boolean)
    while (parts.length > 0) {
      const candidate = "/" + parts.join("/")
      if (PATH_LABELS[candidate]) return PATH_LABELS[candidate]
      parts.pop()
    }
    return ""
  }, [pathname])

  useHotkeys("g d", () => router.push("/dashboard"))
  useHotkeys("g n", () => router.push("/nodes"))
  useHotkeys("g a", () => router.push("/ai"))
  useHotkeys("g s", () => router.push("/sessions"))

  async function logout() {
    try { await authService.logout() } catch { /* ignore */ }
    clearTokens()
    router.replace("/login")
  }

  return (
    <header className="h-14 border-b bg-background/80 backdrop-blur sticky top-0 z-30 px-3 md:px-4 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onMobileMenu} aria-label="菜单">
          <Menu className="w-4 h-4" />
        </Button>
        <div className="text-sm font-medium tracking-tight truncate">{title}</div>
      </div>
      <Sheet open={mobileOpen} onOpenChange={(o) => !o && onMobileClose?.()}>
        <SheetContent side="left" className="p-0 w-72 md:hidden">
          <Sidebar mobile />
        </SheetContent>
      </Sheet>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground hidden sm:inline-flex"
          onClick={() => {
            // Trigger CommandPalette via synthetic Cmd+K keypress.
            const e = new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true })
            document.dispatchEvent(e)
          }}
          aria-label="搜索"
        >
          <Search className="w-4 h-4" />
          <span className="text-xs">搜索 / 跳转</span>
          <kbd className="ml-1 hidden md:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px]">⌘K</kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="切换主题"
          onClick={() => setTheme((resolvedTheme || theme) === "dark" ? "light" : "dark")}
        >
          {mounted && (resolvedTheme || theme) === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
        <NotificationBell />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2 pl-2 pr-3">
              <Avatar className="w-7 h-7">
                <AvatarFallback>{(me?.usr || "?").slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="text-sm hidden sm:inline">{me?.usr || "anonymous"}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="text-sm font-medium">{me?.usr}</div>
              <div className="text-xs text-muted-foreground">
                {tier === "superadmin" ? "超级管理员" : tier === "admin" ? "管理员" : "普通用户"}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={"/me/profile" as Parameters<typeof Link>[0]["href"]}>
                <UserIcon className="w-4 h-4" />
                个人资料
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={"/me/security" as Parameters<typeof Link>[0]["href"]}>
                <UserIcon className="w-4 h-4" />
                安全设置（MFA / Passkey）
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={"/me/login-history" as Parameters<typeof Link>[0]["href"]}>
                <UserIcon className="w-4 h-4" />
                登录历史
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout}>
              <LogOut className="w-4 h-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
