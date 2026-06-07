"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Clock, Command, Plus, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { meService } from "@/lib/api/services"
import type { Node } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { metaOf, protocolChoicesForNode, type ProtocolChoice } from "./protocolMeta"
import { useWorkspaceStore } from "./useWorkspaceStore"

type Props = {
  onNewTab: () => void
}

export function WorkspaceWelcome({ onNewTab }: Props) {
  const open = useWorkspaceStore((s) => s.open)
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const recent = useQuery({ queryKey: ["me", "recents"], queryFn: () => meService.recentNodes(8) })
  const favorites = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })

  const byId = React.useMemo(() => {
    const m = new Map<number, Node>()
    for (const n of nodes.data?.nodes ?? []) m.set(n.id, n)
    return m
  }, [nodes.data?.nodes])

  const recentNodes = (recent.data?.recent ?? [])
    .map((r) => byId.get(r.node_id))
    .filter((n): n is Node => !!n)
    .slice(0, 6)
  const favNodes = (favorites.data?.node_ids ?? [])
    .map((id) => byId.get(id))
    .filter((n): n is Node => !!n)
    .slice(0, 6)

  const openWith = (n: Node, choice: ProtocolChoice) =>
    open({
      nodeId: n.id,
      protocol: choice.protocol,
      rdpBackend: choice.rdpBackend,
      title: n.name,
      host: n.host,
      port: n.port,
    })

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-9 px-6 py-12">
        {/* Hero */}
        <div className="space-y-4">
          <span className="eyebrow">工作台</span>
          <h1 className="display-title text-[2.5rem] leading-[1.1]">
            在一处，接入所有机器
          </h1>
          <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            SSH、远程桌面、数据库、文件传输都在这里。切换会话不会断开后台连接，每一步操作都在审计记录里。
          </p>
          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <Button onClick={onNewTab} className="h-9">
              <Plus className="h-4 w-4" /> 新建会话
              <kbd className="ml-1.5 rounded bg-white/20 px-1.5 py-0.5 font-mono text-[10px]">Ctrl T</kbd>
            </Button>
            <Button variant="outline" asChild className="h-9">
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <Link href={"/nodes" as any}>
                资产列表 <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <span className="ml-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Command className="h-3.5 w-3.5" />
              <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">Ctrl K</kbd>
              快速搜索 · 左侧资产树双击直连
            </span>
          </div>
        </div>

        {favNodes.length > 0 && (
          <Section title="收藏" icon={Star} iconClass="text-[#bf6f33] dark:text-[#e8a55a]">
            {favNodes.map((n) => (
              <NodeQuickCard key={n.id} node={n} onOpen={openWith} />
            ))}
          </Section>
        )}

        {recentNodes.length > 0 && (
          <Section title="最近访问" icon={Clock} iconClass="text-[#4f9d8f] dark:text-[#5db8a6]">
            {recentNodes.map((n) => (
              <NodeQuickCard key={n.id} node={n} onOpen={openWith} />
            ))}
          </Section>
        )}

        {/* Shortcuts */}
        <div className="rounded-xl border bg-card/40 p-4">
          <div className="eyebrow mb-3">键盘速查</div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            <Kbd combo="Ctrl T" desc="新建会话" />
            <Kbd combo="Ctrl W" desc="关闭当前会话" />
            <Kbd combo="Ctrl ⇧ T" desc="撤销关闭" />
            <Kbd combo="Ctrl Tab" desc="切换上一 / 下一个" />
            <Kbd combo="Ctrl 1…9" desc="跳到第 N 个" />
            <Kbd combo="Ctrl K" desc="命令面板" />
            <Kbd combo="Ctrl B" desc="切换侧边栏" />
            <Kbd combo="Ctrl \\" desc="分屏 / 取消分屏" />
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  icon: Icon,
  iconClass,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  iconClass?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <h2 className="inline-flex items-center gap-1.5 text-sm font-medium">
        <Icon className={cn("h-4 w-4", iconClass)} /> {title}
      </h2>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  )
}

function NodeQuickCard({ node, onOpen }: { node: Node; onOpen: (n: Node, choice: ProtocolChoice) => void }) {
  const choices = protocolChoicesForNode(node.protocol)
  const primary = choices[0]
  const meta = metaOf(primary?.protocol ?? "tcp_forward")
  const Icon = meta.icon
  return (
    <button
      type="button"
      onClick={() => primary && onOpen(node, primary)}
      className="group rounded-xl border bg-card p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_2px_12px_-6px_rgba(20,20,19,0.2)]"
    >
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-muted">
          <Icon className={cn("h-4 w-4", meta.tint)} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{node.name}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-primary" />
      </div>
      <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
        {node.host}:{node.port}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1">
        {choices.slice(0, 3).map((choice) => (
          <span
            key={choice.value}
            className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title={choice.description ?? choice.label}
          >
            {choice.label}
          </span>
        ))}
      </div>
    </button>
  )
}

function Kbd({ combo, desc }: { combo: string; desc: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <kbd className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">{combo}</kbd>
      <span>{desc}</span>
    </div>
  )
}
