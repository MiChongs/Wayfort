"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Activity,
  Bot,
  Building2,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Cog,
  FileLock2,
  Gavel,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  Network,
  ScrollText,
  Server,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag as TagIcon,
  Tags,
  Users,
  Zap,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAccess, tierRank } from "@/lib/hooks/use-access"
import type { AccessTier } from "@/lib/api/types"

type IconType = React.ComponentType<{ className?: string }>
type NavItem = {
  href: string
  label: string
  icon: IconType
  /** Minimum tier required to see this item. Defaults to "user". */
  minTier?: AccessTier
}
type NavGroup = { title?: string; minTier?: AccessTier; items: NavItem[] }

const NAV: NavGroup[] = [
  {
    items: [
      { href: "/dashboard", label: "总览", icon: LayoutDashboard },
      { href: "/workspace", label: "工作台", icon: LayoutGrid },
      { href: "/nodes", label: "节点", icon: Server },
      { href: "/sessions", label: "会话", icon: Activity },
      { href: "/approvals", label: "审批", icon: CheckCircle },
      { href: "/port-forwards", label: "端口转发", icon: Share2 },
      { href: "/ssh-tools", label: "SSH 工具", icon: Zap },
      { href: "/ai", label: "AI 助手", icon: Sparkles },
    ],
  },
  {
    title: "资产管理",
    minTier: "admin",
    items: [
      { href: "/admin/nodes", label: "资产 - 节点", icon: Server, minTier: "admin" },
      { href: "/admin/credentials", label: "凭据", icon: KeyRound, minTier: "admin" },
      { href: "/admin/proxies", label: "代理", icon: Network, minTier: "admin" },
      { href: "/admin/chain-templates", label: "代理链模板", icon: Sparkles, minTier: "admin" },
      { href: "/admin/asset-groups", label: "资产组", icon: Tags, minTier: "admin" },
      { href: "/admin/tags", label: "标签", icon: TagIcon, minTier: "admin" },
      { href: "/admin/asset-grants", label: "访问策略", icon: FileLock2, minTier: "admin" },
      { href: "/admin/approvals", label: "审批治理", icon: Gavel, minTier: "admin" },
    ],
  },
  {
    title: "系统管理",
    minTier: "superadmin",
    items: [
      { href: "/admin/users", label: "用户", icon: Users, minTier: "superadmin" },
      { href: "/admin/roles", label: "角色 / 权限", icon: ShieldCheck, minTier: "superadmin" },
      { href: "/admin/organization", label: "组织架构", icon: Building2, minTier: "superadmin" },
      { href: "/admin/oidc-clients", label: "OIDC 客户端", icon: ShieldCheck, minTier: "superadmin" },
      { href: "/admin/ai/providers", label: "AI 提供商", icon: Bot, minTier: "superadmin" },
      { href: "/admin/ai/agents", label: "AI Agent", icon: Bot, minTier: "superadmin" },
      { href: "/admin/audit", label: "审计日志", icon: ScrollText, minTier: "superadmin" },
      { href: "/admin/settings", label: "系统设置", icon: SlidersHorizontal, minTier: "superadmin" },
    ],
  },
]

const COLLAPSE_KEY = "jumpserver:sidebar:collapsed"

export function Sidebar({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname()
  const { tier } = useAccess()
  const [collapsed, setCollapsed] = React.useState(false)

  React.useEffect(() => {
    if (mobile) return
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1")
    } catch {
      /* ignore */
    }
  }, [mobile])

  const toggle = () => {
    setCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0")
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const isCollapsed = collapsed && !mobile
  const rank = tierRank(tier)

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((it) => rank >= tierRank(it.minTier ?? "user")),
  })).filter((g) => g.items.length > 0 && rank >= tierRank(g.minTier ?? "user"))

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200",
        mobile ? "h-full w-full" : "sticky top-0 hidden h-screen md:flex",
        !mobile && (isCollapsed ? "w-[68px]" : "w-60"),
      )}
    >
      {/* Brand */}
      <div
        className={cn(
          "flex h-14 items-center gap-2.5 border-b border-sidebar-border px-3.5",
          isCollapsed && "justify-center px-0",
        )}
      >
        <SpikeMark className="h-7 w-7 shrink-0" />
        {!isCollapsed && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[15px] font-semibold tracking-tight text-sidebar-accent-foreground">
              JumpServer
            </div>
            <div className="truncate text-[10px] text-muted-foreground">多协议运维网关</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-3">
        {groups.map((g, gi) => (
          <div key={gi} className="space-y-1">
            {g.title && !isCollapsed && <div className="eyebrow px-2 pb-1">{g.title}</div>}
            {g.title && isCollapsed && <div className="mx-2 mb-1 border-t border-sidebar-border/70" />}
            <div className="space-y-0.5">
              {g.items.map((it) => {
                const active = pathname === it.href || pathname.startsWith(it.href + "/")
                const Icon = it.icon
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    title={isCollapsed ? it.label : undefined}
                    className={cn(
                      "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                      isCollapsed && "justify-center px-0",
                    )}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-sidebar-primary" />
                    )}
                    <Icon
                      className={cn(
                        "h-[18px] w-[18px] shrink-0 transition-colors",
                        active
                          ? "text-sidebar-primary"
                          : "text-sidebar-foreground/60 group-hover:text-sidebar-accent-foreground",
                      )}
                    />
                    {!isCollapsed && <span className="truncate">{it.label}</span>}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="space-y-1 border-t border-sidebar-border p-2.5">
        <Link
          href="/me/profile"
          title={isCollapsed ? "个人设置" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            isCollapsed && "justify-center px-0",
          )}
        >
          <Cog className="h-[18px] w-[18px] shrink-0 text-sidebar-foreground/60" />
          {!isCollapsed && <span>个人设置</span>}
        </Link>
        {!mobile && (
          <button
            type="button"
            onClick={toggle}
            title={isCollapsed ? "展开侧栏" : "收起侧栏"}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              isCollapsed && "justify-center px-0",
            )}
          >
            {isCollapsed ? (
              <ChevronRight className="h-[18px] w-[18px] shrink-0" />
            ) : (
              <ChevronLeft className="h-[18px] w-[18px] shrink-0" />
            )}
            {!isCollapsed && <span>收起</span>}
          </button>
        )}
      </div>
    </aside>
  )
}

// SpikeMark — an Anthropic-flavoured radial mark inside a coral rounded tile.
function SpikeMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-[9px] bg-sidebar-primary text-sidebar-primary-foreground",
        className,
      )}
      aria-hidden
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
      >
        <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
      </svg>
    </span>
  )
}
