"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { ExternalLink, Keyboard, LogOut, Moon, Sun, SunMoon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { authService } from "@/lib/api/services"
import { clearTokens } from "@/lib/auth/tokens"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { useAccess } from "@/lib/hooks/use-access"

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev"
const REPO = "https://github.com/MiChongs/Wayfort"

const THEMES: { value: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "light", label: "明亮", icon: Sun },
  { value: "dark", label: "暗色", icon: Moon },
  { value: "system", label: "跟随系统", icon: SunMoon },
]

// Account menu pinned to the activity bar's foot — absorbs everything the old
// Menubar's File/Theme/Help menus carried (theme, shortcuts, repo, version,
// logout). Opens to the right since it lives in the left rail.
export function UserMenu({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const router = useRouter()
  const me = useCurrentUser()
  const { tier } = useAccess()
  const { theme, setTheme } = useTheme()
  const initials = (me?.usr || "?").slice(0, 2).toUpperCase()

  const logout = async () => {
    try {
      await authService.logout()
    } catch {
      // token already invalid or backend unreachable — clear locally either way
    }
    clearTokens()
    router.replace("/login")
  }

  const role = me?.anon
    ? "匿名会话"
    : tier === "superadmin"
      ? "超级管理员"
      : tier === "admin"
        ? "管理员"
        : "普通用户"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="账户菜单"
          className="grid h-9 w-9 place-items-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-[11px] font-medium">{initials}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{me?.usr || "anonymous"}</div>
          <div className="text-xs text-muted-foreground">{role}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground/70">主题</div>
        {THEMES.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={(e) => {
              e.preventDefault()
              setTheme(value)
            }}
          >
            <Icon className="h-4 w-4" />
            {label}
            {theme === value && <DropdownMenuShortcut>✓</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onShowShortcuts}>
          <Keyboard className="h-4 w-4" />
          键盘快捷键
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.open(REPO, "_blank", "noopener,noreferrer")}>
          <ExternalLink className="h-4 w-4" />
          文档 / 仓库
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>
          <LogOut className="h-4 w-4" />
          退出登录
        </DropdownMenuItem>
        <div className="px-2 pb-0.5 pt-1 text-[10px] text-muted-foreground/60">版本 {VERSION}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
