"use client"

import * as React from "react"
import { ChevronRight, Star } from "lucide-react"
import { toast } from "sonner"
import type { Node } from "@/lib/api/types"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
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
import { metaOf, protocolsForNode, PROTOCOL_META } from "./protocolMeta"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

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

type Props = {
  item: TreeItem
  depth?: number
  onOpenTab: (node: Node, protocol: Protocol) => void
  onToggleFavorite?: (node: Node) => void
}

export function AssetTreeNode({ item, depth = 0, onOpenTab, onToggleFavorite }: Props) {
  if (item.type === "folder") {
    return <FolderRow folder={item} depth={depth} onOpenTab={onOpenTab} onToggleFavorite={onToggleFavorite} />
  }
  return <LeafRow leaf={item} depth={depth} onOpenTab={onOpenTab} onToggleFavorite={onToggleFavorite} />
}

function FolderRow({
  folder,
  depth,
  onOpenTab,
  onToggleFavorite,
}: {
  folder: TreeFolder
  depth: number
  onOpenTab: (node: Node, protocol: Protocol) => void
  onToggleFavorite?: (node: Node) => void
}) {
  const Icon = folder.icon
  return (
    <Collapsible defaultOpen={folder.defaultOpen ?? depth === 0}>
      <CollapsibleTrigger
        className={cn(
          "group/folder w-full flex items-center gap-1 px-2 py-1 rounded-sm text-sm",
          "hover:bg-accent/60 transition-colors",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 group-data-[state=open]/folder:rotate-90" />
        {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <span className="truncate flex-1 text-left font-medium">{folder.label}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{folder.count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {folder.children.map((c) => (
          <AssetTreeNode
            key={c.id}
            item={c}
            depth={depth + 1}
            onOpenTab={onOpenTab}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
        {folder.children.length === 0 && (
          <div
            className="text-xs text-muted-foreground py-1 italic"
            style={{ paddingLeft: 8 + (depth + 1) * 12 + 16 }}
          >
            （空）
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function LeafRow({
  leaf,
  depth,
  onOpenTab,
  onToggleFavorite,
}: {
  leaf: TreeLeaf
  depth: number
  onOpenTab: (node: Node, protocol: Protocol) => void
  onToggleFavorite?: (node: Node) => void
}) {
  const protocols = protocolsForNode(leaf.node.protocol)
  const defaultProto = protocols[0]
  const meta = metaOf(defaultProto)
  const Icon = meta.icon
  const open = useWorkspaceStore((s) => s.open)
  const setSubTab = useWorkspaceStore((s) => s.setSubTab)

  // Open the default protocol AND flip the dock straight to 节点信息 so the
  // user lands on the metadata tab — replaces the old "节点详情(新页面)"
  // jump-out without leaving the workspace.
  const openWithInfo = () => {
    const id = open({
      nodeId: leaf.node.id,
      protocol: defaultProto,
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
          type="button"
          onDoubleClick={() => onOpenTab(leaf.node, defaultProto)}
          title={`${leaf.node.name} (${leaf.node.host}:${leaf.node.port}) — 双击连接`}
          className={cn(
            "group/leaf w-full flex items-center gap-2 px-2 py-1 rounded-sm text-sm",
            "hover:bg-accent/60 active:bg-accent transition-colors",
            leaf.node.disabled && "opacity-50",
          )}
          style={{ paddingLeft: 8 + depth * 12 + 16 }}
        >
          <Icon className={cn("w-3.5 h-3.5 shrink-0", meta.tint)} />
          <span className="truncate flex-1 text-left">{leaf.node.name}</span>
          {leaf.isFavorite && <Star className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />}
          <span className="text-[10px] text-muted-foreground uppercase shrink-0">
            {leaf.node.protocol}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="truncate">{leaf.node.name}</ContextMenuLabel>
        <ContextMenuSeparator />
        {protocols.length === 1 ? (
          <ContextMenuItem onSelect={() => onOpenTab(leaf.node, protocols[0])}>
            <Icon className={cn("w-4 h-4", meta.tint)} />
            <span>打开 · {meta.label}</span>
          </ContextMenuItem>
        ) : (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Icon className={cn("w-4 h-4", meta.tint)} />
              <span>在工作台打开</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {protocols.map((p) => {
                const m = PROTOCOL_META[p]
                const PIcon = m.icon
                return (
                  <ContextMenuItem key={p} onSelect={() => onOpenTab(leaf.node, p)}>
                    <PIcon className={cn("w-4 h-4", m.tint)} />
                    <span>{m.label}</span>
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
            <Star className="w-4 h-4" />
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
