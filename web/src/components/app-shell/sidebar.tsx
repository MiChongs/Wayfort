"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Activity,
  Bot,
  ChevronDown,
  Cog,
  FileLock2,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  Network,
  ScrollText,
  Server,
  Share2,
  ShieldCheck,
  Sparkles,
  Tag as TagIcon,
  Tags,
  Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useCurrentUser } from "@/lib/hooks/use-current-user"

type NavGroup = {
  title?: string
  items: { href: string; label: string; icon: React.ComponentType<{ className?: string }>; adminOnly?: boolean }[]
}

const NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "总览", icon: LayoutDashboard },
      { href: "/workspace", label: "工作台", icon: LayoutGrid },
      { href: "/nodes", label: "节点", icon: Server },
      { href: "/sessions", label: "会话", icon: Activity },
      { href: "/port-forwards", label: "端口转发", icon: Share2 },
      { href: "/ai", label: "AI 助手", icon: Sparkles },
    ],
  },
  {
    title: "管理",
    items: [
      { href: "/admin/users", label: "用户", icon: Users, adminOnly: true },
      { href: "/admin/roles", label: "角色 / 权限", icon: ShieldCheck, adminOnly: true },
      { href: "/admin/departments", label: "部门", icon: Network, adminOnly: true },
      { href: "/admin/groups", label: "用户组", icon: Users, adminOnly: true },
      { href: "/admin/nodes", label: "资产 - 节点", icon: Server, adminOnly: true },
      { href: "/admin/credentials", label: "凭据", icon: KeyRound, adminOnly: true },
      { href: "/admin/proxies", label: "代理", icon: Network, adminOnly: true },
      { href: "/admin/chain-templates", label: "代理链模板", icon: Sparkles, adminOnly: true },
      { href: "/admin/asset-groups", label: "资产组", icon: Tags, adminOnly: true },
      { href: "/admin/tags", label: "标签", icon: TagIcon, adminOnly: true },
      { href: "/admin/asset-grants", label: "资产授权", icon: FileLock2, adminOnly: true },
      { href: "/admin/oidc-clients", label: "OIDC 客户端", icon: ShieldCheck, adminOnly: true },
      { href: "/admin/ai/providers", label: "AI 提供商", icon: Bot, adminOnly: true },
      { href: "/admin/ai/agents", label: "AI Agent", icon: Bot, adminOnly: true },
      { href: "/admin/audit", label: "审计日志", icon: ScrollText, adminOnly: true },
    ],
  },
]

export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname()
  const me = useCurrentUser()
  const isAdmin = me?.adm === true

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((it) => !it.adminOnly || isAdmin),
  })).filter((g) => g.items.length > 0)

  return (
    <aside
      className={cn(
        "border-r bg-sidebar text-sidebar-foreground h-screen sticky top-0 hidden md:flex flex-col transition-[width]",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="h-14 flex items-center px-4 gap-2 border-b">
        <Server className="w-5 h-5 text-sidebar-primary" />
        {!collapsed && <span className="font-semibold tracking-tight">JumpServer</span>}
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-4">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.title && !collapsed && (
              <div className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {g.title}
              </div>
            )}
            <div className="space-y-0.5">
              {g.items.map((it) => {
                const active = pathname === it.href || pathname.startsWith(it.href + "/")
                const Icon = it.icon
                return (
                  <Link
                    key={it.href}
                    href={it.href as Parameters<typeof Link>[0]["href"]}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors",
                      active && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
                      collapsed && "justify-center"
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {!collapsed && <span className="truncate">{it.label}</span>}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="p-2 border-t">
        <Link
          href={"/me/profile" as Parameters<typeof Link>[0]["href"]}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            collapsed && "justify-center"
          )}
        >
          <Cog className="w-4 h-4" />
          {!collapsed && <span>个人设置</span>}
        </Link>
      </div>
      {!collapsed && <ChevronDown className="hidden" />}
    </aside>
  )
}
