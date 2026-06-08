"use client"

import * as React from "react"
import { Star } from "lucide-react"
import { useDraggable } from "@dnd-kit/core"
import { toast } from "@/components/ui/sonner"
import { StatusDot, statusToState } from "@/components/asset-tree/status-dot"
import type { Node, NodeStatus } from "@/lib/api/types"
import type { DesktopBackend } from "@/lib/desktop/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { metaOf, protocolChoicesForNode, PROTOCOL_META, type ProtocolChoice } from "./protocolMeta"
import { type Protocol } from "./useWorkspaceStore"
import { useWorkspaceStore } from "./useWorkspaceStore"

// The workspace tree's data model. Rendering is now done by the shared
// <TreeList> (indent / chevron / keyboard); this file only provides the
// per-row CONTENT renderers (folder header, leaf with context menu).
export type TreeFolder = {
  type: "folder"
  id: string
  label: string
  count: number
  icon?: React.ComponentType<{ className?: string }>
  defaultOpen?: boolean
  children: TreeItem[]
}
export type TreeLeaf = {
  type: "leaf"
  id: string
  node: Node
  isFavorite?: boolean
}
export type TreeItem = TreeFolder | TreeLeaf

export function FolderContent({ folder }: { folder: TreeFolder }) {
  const Icon = folder.icon
  return (
    <div className="flex items-center gap-1.5 py-1 pr-1 text-sm">
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="flex-1 truncate text-left font-medium">{folder.label}</span>
      <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{folder.count}</span>
    </div>
  )
}

export function LeafContent({
  leaf,
  onOpenTab,
  onToggleFavorite,
  status,
  checking,
  onRequestStatus,
  onOpenDetail,
}: {
  leaf: TreeLeaf
  onOpenTab: (node: Node, protocol: Protocol, rdpBackend?: DesktopBackend) => void
  onToggleFavorite?: (node: Node) => void
  status?: NodeStatus | null
  checking?: boolean
  onRequestStatus?: (id: number) => void
  onOpenDetail?: (node: Node) => void
}) {
  const choices = protocolChoicesForNode(leaf.node.protocol)
  const defaultChoice = choices[0]
  const defaultProto = defaultChoice?.protocol ?? "tcp_forward"
  const meta = metaOf(defaultProto)
  const Icon = meta.icon
  const open = useWorkspaceStore((s) => s.open)
  const setSubTab = useWorkspaceStore((s) => s.setSubTab)
  // Drag this leaf onto the session area (handled in WorkspaceShell) to open
  // it. PointerSensor's 6px threshold keeps double-click-to-open working.
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: leaf.id,
    data: { node: leaf.node },
  })

  const openWithInfo = () => {
    const id = open({
      nodeId: leaf.node.id,
      protocol: defaultProto,
      rdpBackend: defaultChoice?.rdpBackend,
      title: leaf.node.name,
      host: leaf.node.host,
      port: leaf.node.port,
    })
    if (id) setSubTab(id, "info")
  }

  const copyHostPort = () => {
    const v = `${leaf.node.host}:${leaf.node.port}`
    void navigator.clipboard?.writeText(v)
    toast.success("已复制", { description: v })
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          ref={setNodeRef}
          type="button"
          {...listeners}
          onClick={() => onOpenDetail?.(leaf.node)}
          onDoubleClick={() => onOpenTab(leaf.node, defaultProto, defaultChoice?.rdpBackend)}
          onMouseEnter={() => onRequestStatus?.(leaf.node.id)}
          title={`${leaf.node.name} (${leaf.node.host}:${leaf.node.port}) — 单击详情 · 双击连接 · 可拖到右侧打开`}
          className={cn(
            "group/leaf flex w-full items-center gap-2 py-1 pr-1 text-sm",
            leaf.node.disabled && "opacity-50",
            isDragging && "opacity-50",
          )}
        >
          <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.tint)} />
          <span className="flex-1 truncate text-left">{leaf.node.name}</span>
          {leaf.isFavorite && <Star className="h-3 w-3 shrink-0 fill-[#e8a55a] text-[#e8a55a]" />}
          <StatusDot
            state={statusToState(status, checking)}
            latencyMs={status?.latency_ms}
            pulse={false}
          />
          <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{leaf.node.protocol}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="truncate">{leaf.node.name}</ContextMenuLabel>
        <ContextMenuSeparator />
        {choices.length === 1 ? (
          <ContextMenuItem onSelect={() => openChoice(onOpenTab, leaf.node, choices[0])}>
            <Icon className={cn("h-4 w-4", meta.tint)} />
            <span>打开 · {choices[0].label}</span>
          </ContextMenuItem>
        ) : (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Icon className={cn("h-4 w-4", meta.tint)} />
              <span>在工作台打开</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {choices.map((choice) => {
                const m = PROTOCOL_META[choice.protocol]
                const PIcon = m.icon
                return (
                  <ContextMenuItem key={choice.value} onSelect={() => openChoice(onOpenTab, leaf.node, choice)}>
                    <PIcon className={cn("h-4 w-4", m.tint)} />
                    <span>{choice.label}</span>
                  </ContextMenuItem>
                )
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuItem onSelect={openWithInfo}>
          <span>打开 + 查看节点信息</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {onToggleFavorite && (
          <ContextMenuItem onSelect={() => onToggleFavorite(leaf.node)}>
            <Star className="h-4 w-4" />
            <span>{leaf.isFavorite ? "取消收藏" : "加入收藏"}</span>
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={copyHostPort}>
          <span>复制 host:port</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function openChoice(
  onOpenTab: (node: Node, protocol: Protocol, rdpBackend?: DesktopBackend) => void,
  node: Node,
  choice: ProtocolChoice,
) {
  onOpenTab(node, choice.protocol, choice.rdpBackend)
}
