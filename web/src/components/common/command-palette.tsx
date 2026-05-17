"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import {
  Activity, Bot, KeyRound, LayoutDashboard, Network, Server,
  Settings, Share2, ShieldCheck, Sparkles, Tag as TagIcon, Tags, Users,
} from "lucide-react"
import { useHotkeys } from "react-hotkeys-hook"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut,
} from "@/components/ui/command"
import { meService, aiConversationService } from "@/lib/api/services"
import { useCurrentUser } from "@/lib/hooks/use-current-user"

type Action = {
  group: string
  label: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  onSelect: () => void
}

// Global ⌘K / Ctrl+K palette. Surfaces:
//   1. quick jump to top-level routes
//   2. recent AI conversations
//   3. fuzzy search of currently visible nodes (deep-link to /nodes/[id])
export function CommandPalette() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  const me = useCurrentUser()
  const isAdmin = me?.adm === true

  useHotkeys("mod+k", (e) => { e.preventDefault(); setOpen((v) => !v) }, { enableOnFormTags: true })
  useHotkeys("/", (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === "INPUT" || tag === "TEXTAREA") return
    e.preventDefault()
    setOpen(true)
  })

  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes, enabled: open })
  const convs = useQuery({ queryKey: ["ai", "convs"], queryFn: aiConversationService.list, enabled: open })

  function go(path: string) {
    setOpen(false)
    router.push(path as Parameters<typeof router.push>[0])
  }

  const navActions: Action[] = [
    { group: "导航", label: "总览", icon: LayoutDashboard, onSelect: () => go("/dashboard") },
    { group: "导航", label: "节点", icon: Server, onSelect: () => go("/nodes") },
    { group: "导航", label: "会话历史", icon: Activity, onSelect: () => go("/sessions") },
    { group: "导航", label: "端口转发", icon: Share2, onSelect: () => go("/port-forwards") },
    { group: "导航", label: "AI 助手", icon: Sparkles, onSelect: () => go("/ai") },
    { group: "导航", label: "个人资料", icon: Settings, onSelect: () => go("/me/profile") },
    { group: "导航", label: "安全设置（MFA / Passkey）", icon: ShieldCheck, onSelect: () => go("/me/security") },
  ]

  const adminActions: Action[] = isAdmin
    ? [
        { group: "管理", label: "用户管理", icon: Users, onSelect: () => go("/admin/users") },
        { group: "管理", label: "角色与权限", icon: ShieldCheck, onSelect: () => go("/admin/roles") },
        { group: "管理", label: "部门", icon: Network, onSelect: () => go("/admin/departments") },
        { group: "管理", label: "资产 - 节点", icon: Server, onSelect: () => go("/admin/nodes") },
        { group: "管理", label: "凭据", icon: KeyRound, onSelect: () => go("/admin/credentials") },
        { group: "管理", label: "代理", icon: Network, onSelect: () => go("/admin/proxies") },
        { group: "管理", label: "资产组", icon: Tags, onSelect: () => go("/admin/asset-groups") },
        { group: "管理", label: "标签", icon: TagIcon, onSelect: () => go("/admin/tags") },
        { group: "管理", label: "资产授权", icon: ShieldCheck, onSelect: () => go("/admin/asset-grants") },
        { group: "管理", label: "OIDC 客户端", icon: ShieldCheck, onSelect: () => go("/admin/oidc-clients") },
        { group: "管理", label: "AI 提供商", icon: Bot, onSelect: () => go("/admin/ai/providers") },
        { group: "管理", label: "AI Agent", icon: Bot, onSelect: () => go("/admin/ai/agents") },
      ]
    : []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0 max-w-2xl overflow-hidden">
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <Command shouldFilter>
          <CommandInput placeholder="搜索节点 / 跳转页面 / 最近对话…" />
          <CommandList>
            <CommandEmpty>没有匹配项</CommandEmpty>
            <CommandGroup heading="导航">
              {navActions.map((a) => (
                <CommandItem key={a.label} value={`${a.group} ${a.label}`} onSelect={a.onSelect}>
                  <a.icon className="w-4 h-4" /> {a.label}
                  {a.hint && <CommandShortcut>{a.hint}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
            {(nodes.data?.nodes?.length ?? 0) > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="节点">
                  {(nodes.data!.nodes).slice(0, 50).map((n) => (
                    <CommandItem
                      key={n.id}
                      value={`节点 ${n.name} ${n.host} ${n.tags || ""} ${n.protocol}`}
                      onSelect={() => go(`/nodes/${n.id}`)}
                    >
                      <Server className="w-4 h-4" />
                      <span className="flex-1">
                        {n.name}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {n.protocol} · {n.host}:{n.port}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            {(convs.data?.conversations?.length ?? 0) > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="最近 AI 对话">
                  {(convs.data!.conversations).slice(0, 8).map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`对话 ${c.title}`}
                      onSelect={() => go(`/ai/conversations/${c.id}`)}
                    >
                      <Sparkles className="w-4 h-4" />
                      <span className="flex-1 truncate">{c.title}</span>
                      <span className="text-xs text-muted-foreground">{c.permission_mode}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            {adminActions.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="管理">
                  {adminActions.map((a) => (
                    <CommandItem key={a.label} value={`管理 ${a.label}`} onSelect={a.onSelect}>
                      <a.icon className="w-4 h-4" /> {a.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
