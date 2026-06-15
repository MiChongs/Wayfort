"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import {
  Copy,
  PanelLeft,
  RotateCcw,
  Server,
  SplitSquareHorizontal,
  Star,
  SunMoon,
  Undo2,
  X,
} from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { meService } from "@/lib/api/services"
import type { Node } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { metaOf, protocolChoicesForNode, type ProtocolChoice } from "./protocolMeta"
import { useRdpBackendPreference } from "@/lib/desktop/use-rdp-backend"
import { parseConnectCommand, matchProtocol } from "./lib/cmdParse"
import { useWorkspaceStore } from "./useWorkspaceStore"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Two-step launcher + command surface:
//   1. pick a node (fuzzy search of every visible asset) OR run a workspace
//      action (close / split / reconnect / theme …)
//   2. pick a protocol (the protocols that node supports)
// Step 2 is skipped when the node only supports a single protocol.
export function NewTabLauncher({ open, onOpenChange }: Props) {
  const openTab = useWorkspaceStore((s) => s.open)
  const closeTab = useWorkspaceStore((s) => s.close)
  const duplicate = useWorkspaceStore((s) => s.duplicate)
  const setStatus = useWorkspaceStore((s) => s.setStatus)
  const toggleSplit = useWorkspaceStore((s) => s.toggleSplit)
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar)
  const closeAll = useWorkspaceStore((s) => s.closeAll)
  const reopenLastClosed = useWorkspaceStore((s) => s.reopenLastClosed)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const isSplit = useWorkspaceStore((s) => s.split.layout !== "single")
  const openTabs = useWorkspaceStore((s) => s.tabs)
  const { theme, setTheme } = useTheme()

  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const recents = useQuery({ queryKey: ["me", "recents"], queryFn: () => meService.recentNodes(20) })
  const favorites = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })

  const preferredRdp = useRdpBackendPreference()
  const [pickedNode, setPickedNode] = React.useState<Node | null>(null)
  const [q, setQ] = React.useState("")

  React.useEffect(() => {
    if (!open) {
      setPickedNode(null)
      setQ("")
    }
  }, [open])

  const all: Node[] = nodes.data?.nodes ?? []
  const byId = React.useMemo(() => new Map(all.map((n) => [n.id, n])), [all])
  const favIds = new Set(favorites.data?.node_ids ?? [])
  const openNodeIds = new Set(openTabs.map((t) => t.nodeId))
  const recentOrdered = (recents.data?.recent ?? [])
    .map((r) => byId.get(r.node_id))
    .filter((n): n is Node => !!n)

  const enabled = all.filter((n) => !n.disabled)

  // Quick-connect: typing "ssh:web01" surfaces a "直达" group that opens that
  // protocol on the matched node(s) in one step. Falls back to fuzzy search
  // when the input isn't a "proto:host" command.
  const parsed = parseConnectCommand(q)
  const directMatches: { node: Node; choice: ProtocolChoice }[] = []
  if (parsed) {
    const k = parsed.host.toLowerCase()
    for (const n of enabled) {
      if (!n.name.toLowerCase().includes(k) && !(n.host ?? "").toLowerCase().includes(k)) continue
      const choices = protocolChoicesForNode(n.protocol, preferredRdp)
      const proto = matchProtocol(
        parsed.prefix,
        choices.map((c) => c.protocol),
      )
      const choice = proto ? choices.find((c) => c.protocol === proto) : undefined
      if (choice) directMatches.push({ node: n, choice })
      if (directMatches.length >= 6) break
    }
  }

  const completeOpen = (node: Node, choice: ProtocolChoice) => {
    openTab({
      nodeId: node.id,
      protocol: choice.protocol,
      rdpBackend: choice.rdpBackend,
      title: node.name,
      host: node.host,
      port: node.port,
    })
    onOpenChange(false)
  }

  const run = (fn: () => void) => {
    fn()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden p-0">
        <DialogTitle className="sr-only">新建会话 / 命令面板</DialogTitle>
        <Command shouldFilter>
          {!pickedNode ? (
            <>
              <CommandInput
                value={q}
                onValueChange={setQ}
                placeholder="搜索节点 · 输入 ssh:web01 直连 · 或动作（分屏 / 主题…）"
                autoFocus
              />
              <CommandList className="max-h-[60vh]">
                <CommandEmpty>没有匹配的节点或动作</CommandEmpty>

                {parsed && directMatches.length > 0 && (
                  <>
                    <CommandGroup heading="直达">
                      {directMatches.map(({ node, choice }) => {
                        const meta = metaOf(choice.protocol)
                        const Icon = meta.icon
                        return (
                          <CommandItem
                            key={`direct-${node.id}`}
                            value={`${q} ${node.name} ${node.host ?? ""}`}
                            onSelect={() => completeOpen(node, choice)}
                            className="gap-2.5"
                          >
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/12">
                              <Icon className={cn("h-4 w-4", meta.tint)} />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-sm font-medium">{node.name}</span>
                              <span className="truncate font-mono text-[11px] text-muted-foreground">
                                {node.host}
                                {node.port ? `:${node.port}` : ""}
                              </span>
                            </span>
                            <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              {meta.label}
                            </span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                    <CommandSeparator />
                  </>
                )}

                <CommandGroup heading="工作台动作">
                  {activeId && (
                    <ActionItem
                      icon={SplitSquareHorizontal}
                      label={isSplit ? "取消并排" : "并排查看当前会话"}
                      keywords="split 分屏 并排 side"
                      onSelect={() => run(toggleSplit)}
                    />
                  )}
                  {activeId && (
                    <ActionItem
                      icon={RotateCcw}
                      label="重连当前会话"
                      keywords="reconnect restart 重连 重启"
                      onSelect={() => run(() => activeId && setStatus(activeId, "connecting"))}
                    />
                  )}
                  {activeId && (
                    <ActionItem
                      icon={Copy}
                      label="复制当前会话"
                      keywords="duplicate copy 复制"
                      onSelect={() => run(() => activeId && duplicate(activeId))}
                    />
                  )}
                  {activeId && (
                    <ActionItem
                      icon={X}
                      label="关闭当前会话"
                      keywords="close 关闭"
                      onSelect={() => run(() => activeId && closeTab(activeId))}
                    />
                  )}
                  <ActionItem
                    icon={Undo2}
                    label="撤销关闭"
                    keywords="reopen undo 撤销 恢复"
                    onSelect={() => run(reopenLastClosed)}
                  />
                  <ActionItem
                    icon={PanelLeft}
                    label="切换侧边栏"
                    keywords="sidebar 侧边栏 toggle"
                    onSelect={() => run(toggleSidebar)}
                  />
                  <ActionItem
                    icon={SunMoon}
                    label={theme === "dark" ? "切换到明亮主题" : "切换到暗色主题"}
                    keywords="theme 主题 dark light 明亮 暗色"
                    onSelect={() => run(() => setTheme(theme === "dark" ? "light" : "dark"))}
                  />
                  {openTabs.length > 0 && (
                    <ActionItem
                      icon={X}
                      label="关闭所有会话"
                      keywords="close all 全部关闭 清空"
                      onSelect={() => run(closeAll)}
                    />
                  )}
                </CommandGroup>

                {recentOrdered.length > 0 && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="最近访问">
                      {recentOrdered.slice(0, 6).map((n) => (
                        <NodeRow key={`recent-${n.id}`} node={n} fav={favIds.has(n.id)} open={openNodeIds.has(n.id)} onPick={pickNode} />
                      ))}
                    </CommandGroup>
                  </>
                )}

                <CommandSeparator />
                <CommandGroup heading="全部资产">
                  {enabled.map((n) => (
                    <NodeRow key={n.id} node={n} fav={favIds.has(n.id)} open={openNodeIds.has(n.id)} onPick={pickNode} />
                  ))}
                </CommandGroup>
              </CommandList>
            </>
          ) : (
            <ProtocolPicker node={pickedNode} onPick={(choice) => completeOpen(pickedNode, choice)} onBack={() => setPickedNode(null)} />
          )}
        </Command>
      </DialogContent>
    </Dialog>
  )

  function pickNode(n: Node) {
    const choices = protocolChoicesForNode(n.protocol, preferredRdp)
    if (choices.length === 1) {
      completeOpen(n, choices[0])
      return
    }
    setPickedNode(n)
    setQ("")
  }
}

function ActionItem({
  icon: Icon,
  label,
  keywords,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  keywords: string
  onSelect: () => void
}) {
  return (
    <CommandItem value={`${label} ${keywords}`} onSelect={onSelect} className="gap-2">
      <span className="grid h-6 w-6 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-sm">{label}</span>
    </CommandItem>
  )
}

function NodeRow({
  node,
  fav,
  open,
  onPick,
}: {
  node: Node
  fav: boolean
  open: boolean
  onPick: (n: Node) => void
}) {
  const choices = protocolChoicesForNode(node.protocol)
  const meta = metaOf(choices[0]?.protocol ?? "tcp_forward")
  const Icon = meta.icon
  const tags = (node.tags ?? "")
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 2)
  return (
    <CommandItem
      value={`${node.name} ${node.host} ${node.protocol} ${node.tags ?? ""} ${node.description ?? ""}`}
      onSelect={() => onPick(node)}
      className="gap-2.5"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted">
        <Icon className={cn("h-4 w-4", meta.tint)} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{node.name}</span>
          {fav && <Star className="h-3 w-3 shrink-0 fill-current text-[#bf6f33] dark:text-[#e8a55a]" />}
          {open && <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#5db872]" title="已打开" />}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {node.host}:{node.port}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {tags.map((t) => (
          <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t}
          </span>
        ))}
        <span className="hidden text-[10px] uppercase text-muted-foreground/70 sm:inline">{node.protocol}</span>
      </span>
    </CommandItem>
  )
}

function ProtocolPicker({
  node,
  onPick,
  onBack,
}: {
  node: Node
  onPick: (choice: ProtocolChoice) => void
  onBack: () => void
}) {
  const preferredRdp = useRdpBackendPreference()
  const choices = protocolChoicesForNode(node.protocol, preferredRdp)
  const remembered = useWorkspaceStore((s) => s.protocolMemory[node.id])
  const ordered = React.useMemo(() => {
    if (!remembered) return choices
    const idx = choices.findIndex(
      (c) => c.protocol === remembered.protocol && c.rdpBackend === remembered.rdpBackend,
    )
    if (idx <= 0) return choices
    const copy = [...choices]
    const [m] = copy.splice(idx, 1)
    return [m, ...copy]
  }, [choices, remembered])
  return (
    <>
      <CommandInput placeholder={`选一个协议打开 ${node.name}…`} autoFocus />
      <CommandList>
        <CommandEmpty>没有可用协议</CommandEmpty>
        <CommandGroup heading={`协议 — ${node.name} (${node.host}:${node.port})`}>
          {ordered.map((choice) => {
            const meta = metaOf(choice.protocol)
            const Icon = meta.icon
            const isRemembered =
              remembered?.protocol === choice.protocol && remembered?.rdpBackend === choice.rdpBackend
            return (
              <CommandItem
                key={choice.value}
                value={`${choice.label} ${choice.value}`}
                onSelect={() => onPick(choice)}
                className="gap-2.5"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted">
                  <Icon className={cn("h-4 w-4", meta.tint)} />
                </span>
                <span className="flex-1 text-sm">{choice.label}</span>
                {isRemembered && (
                  <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    常用
                  </span>
                )}
                {choice.description && (
                  <span className="hidden max-w-[17rem] truncate text-[10px] text-muted-foreground sm:inline">
                    {choice.description}
                  </span>
                )}
              </CommandItem>
            )
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup>
          <CommandItem value="返回 back" onSelect={onBack} className="gap-2 text-muted-foreground">
            <Server className="h-4 w-4" /> 返回节点选择
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </>
  )
}
