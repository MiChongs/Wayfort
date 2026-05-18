"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronRight, Star } from "lucide-react"
import { toast } from "sonner"
import type { Node } from "@/lib/api/types"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { metaOf, protocolsForNode, PROTOCOL_META } from "./protocolMeta"
import type { Protocol } from "./useWorkspaceStore"

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
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null)

  const onContextMenu = (ev: React.MouseEvent) => {
    ev.preventDefault()
    setMenu({ x: ev.clientX, y: ev.clientY })
  }

  return (
    <>
      <button
        type="button"
        onDoubleClick={() => onOpenTab(leaf.node, defaultProto)}
        onContextMenu={onContextMenu}
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
      {menu && (
        <LeafContextMenu
          pos={menu}
          node={leaf.node}
          protocols={protocols}
          onClose={() => setMenu(null)}
          onOpenTab={onOpenTab}
          onToggleFavorite={onToggleFavorite}
        />
      )}
    </>
  )
}

const MENU_W = 240

function LeafContextMenu({
  pos,
  node,
  protocols,
  onClose,
  onOpenTab,
  onToggleFavorite,
}: {
  pos: { x: number; y: number }
  node: Node
  protocols: Protocol[]
  onClose: () => void
  onOpenTab: (node: Node, protocol: Protocol) => void
  onToggleFavorite?: (node: Node) => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  const vw = typeof window !== "undefined" ? window.innerWidth : 1024
  const vh = typeof window !== "undefined" ? window.innerHeight : 768
  const itemsCount = protocols.length + 4
  const left = Math.min(pos.x, vw - MENU_W - 8)
  const top = Math.min(pos.y, vh - itemsCount * 32 - 24)

  const Item = ({
    label,
    onClick,
    icon: Icon,
    color,
  }: {
    label: string
    onClick: () => void
    icon?: React.ComponentType<{ className?: string }>
    color?: string
  }) => (
    <button
      type="button"
      onClick={() => {
        onClick()
        onClose()
      }}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-accent rounded-sm text-left"
    >
      {Icon && <Icon className={cn("w-4 h-4 shrink-0", color)} />}
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left, top, width: MENU_W, zIndex: 80 }}
      className="bg-popover border rounded-md shadow-lg p-1 text-popover-foreground"
    >
      <div className="px-2.5 py-1 text-xs text-muted-foreground truncate">{node.name}</div>
      <div className="-mx-1 my-1 h-px bg-border" />
      {protocols.map((p) => {
        const meta = PROTOCOL_META[p]
        return (
          <Item
            key={p}
            label={`在工作台中打开 · ${meta.label}`}
            onClick={() => onOpenTab(node, p)}
            icon={meta.icon}
            color={meta.tint}
          />
        )
      })}
      <div className="-mx-1 my-1 h-px bg-border" />
      {onToggleFavorite && (
        <Item label="切换收藏" onClick={() => onToggleFavorite(node)} icon={Star} />
      )}
      <Item
        label="复制地址 (host:port)"
        onClick={() => {
          void navigator.clipboard?.writeText(`${node.host}:${node.port}`)
          toast.success("已复制", { description: `${node.host}:${node.port}` })
        }}
      />
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <Link
        href={`/nodes/${node.id}` as any}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-accent rounded-sm"
        onClick={onClose}
      >
        节点详情(新页面)
      </Link>
    </div>
  )
}
