"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Bell, LogOut, Moon, Sun, User as UserIcon } from "lucide-react"
import { useTheme } from "next-themes"
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
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { authService } from "@/lib/api/services"
import { clearTokens } from "@/lib/auth/tokens"

export function TopBar({ title }: { title?: string }) {
  const router = useRouter()
  const me = useCurrentUser()
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  async function logout() {
    try { await authService.logout() } catch { /* ignore */ }
    clearTokens()
    router.replace("/login")
  }

  return (
    <header className="h-14 border-b bg-background/80 backdrop-blur sticky top-0 z-30 px-4 flex items-center justify-between">
      <div className="text-sm font-medium tracking-tight">{title}</div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="切换主题"
          onClick={() => setTheme((resolvedTheme || theme) === "dark" ? "light" : "dark")}
        >
          {mounted && (resolvedTheme || theme) === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
        <Button variant="ghost" size="icon" aria-label="通知">
          <Bell className="w-4 h-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2 pl-2 pr-3">
              <Avatar className="w-7 h-7">
                <AvatarFallback>{(me?.usr || "?").slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="text-sm">{me?.usr || "anonymous"}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="text-sm font-medium">{me?.usr}</div>
              <div className="text-xs text-muted-foreground">{me?.adm ? "管理员" : "普通用户"}</div>
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
