"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, Clock, Command, LayoutGrid, MousePointer2, Sparkles, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { meService } from "@/lib/api/services"
import type { Node } from "@/lib/api/types"
import { metaOf, protocolsForNode } from "./protocolMeta"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

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

  const openWith = (n: Node, p: Protocol) =>
    open({
      nodeId: n.id,
      protocol: p,
      title: n.name,
      host: n.host,
      port: n.port,
    })

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        <div className="text-center space-y-3">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 text-primary">
            <LayoutGrid className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">欢迎来到工作台</h1>
          <p className="text-sm text-muted-foreground max-w-xl mx-auto">
            把多个 SSH / RDP / VNC / SFTP / 端口转发会话装在一个浏览器窗口里。Tab 切换瞬时,
            后台会话不会被掐断,所有操作进入审计。
          </p>
          <div className="flex items-center justify-center gap-2 pt-2">
            <Button onClick={onNewTab}>
              <Sparkles className="w-4 h-4" /> 打开命令面板新建 Tab
              <kbd className="ml-2 px-1.5 py-0.5 rounded bg-card/40 text-xs">Ctrl+T</kbd>
            </Button>
            <Button variant="outline" asChild>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <Link href={"/nodes" as any}>
                浏览全部节点 <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        </div>

        {favNodes.length > 0 && (
          <Section title="收藏" icon={Star} iconClass="text-amber-500">
            {favNodes.map((n) => (
              <NodeQuickCard key={n.id} node={n} onOpen={openWith} />
            ))}
          </Section>
        )}

        {recentNodes.length > 0 && (
          <Section title="最近访问" icon={Clock} iconClass="text-sky-500">
            {recentNodes.map((n) => (
              <NodeQuickCard key={n.id} node={n} onOpen={openWith} />
            ))}
          </Section>
        )}

        <div className="rounded-lg border bg-card/30 p-4 text-xs text-muted-foreground space-y-1.5">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Command className="w-3.5 h-3.5" /> 键盘快捷键
          </div>
          <Kbd combo="Ctrl/⌘ + T" desc="新建 Tab（命令面板）" />
          <Kbd combo="Ctrl/⌘ + W" desc="关闭当前 Tab" />
          <Kbd combo="Ctrl/⌘ + Shift + T" desc="撤销关闭" />
          <Kbd combo="Ctrl/⌘ + Tab" desc="下一个 / 上一个 Tab" />
          <Kbd combo="Ctrl/⌘ + 1..9" desc="跳到第 N 个 Tab" />
          <Kbd combo="Ctrl/⌘ + K" desc="命令面板" />
          <Kbd combo="Ctrl/⌘ + B" desc="切换侧边栏" />
          <Kbd combo="F11" desc="当前 Tab 全屏" />
          <div className="pt-1 inline-flex items-center gap-1.5">
            <MousePointer2 className="w-3 h-3" /> 树里双击节点直接连接 · 右键选具体协议
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
    <section>
      <h2 className="text-sm font-semibold mb-2 inline-flex items-center gap-1.5">
        <Icon className={`w-4 h-4 ${iconClass ?? ""}`} /> {title}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{children}</div>
    </section>
  )
}

function NodeQuickCard({ node, onOpen }: { node: Node; onOpen: (n: Node, p: Protocol) => void }) {
  const protos = protocolsForNode(node.protocol)
  const primary = protos[0]
  const meta = metaOf(primary)
  const Icon = meta.icon
  return (
    <button
      type="button"
      onClick={() => onOpen(node, primary)}
      className="text-left rounded-lg border bg-card p-3 hover:bg-accent/40 transition-colors group"
    >
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${meta.tint}`} />
        <span className="font-medium truncate flex-1">{node.name}</span>
        <span className="text-[10px] text-muted-foreground uppercase">{node.protocol}</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground font-mono truncate">
        {node.host}:{node.port}
      </div>
      <div className="mt-2 flex gap-1 flex-wrap">
        {protos.map((p) => {
          const m = metaOf(p)
          return (
            <span
              key={p}
              className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
              title={m.label}
            >
              {m.label}
            </span>
          )
        })}
      </div>
    </button>
  )
}

function Kbd({ combo, desc }: { combo: string; desc: string }) {
  return (
    <div className="flex items-center gap-2">
      <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono shrink-0">{combo}</kbd>
      <span>{desc}</span>
    </div>
  )
}
