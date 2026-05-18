"use client"

import * as React from "react"
import { Clock, FolderTree, Network, Star, Tag, ListChecks } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TreeView } from "./useWorkspaceStore"

const ITEMS: { key: TreeView; label: string; icon: React.ComponentType<{ className?: string }>; title: string }[] = [
  { key: "favorites", label: "收藏", icon: Star, title: "收藏夹" },
  { key: "recent", label: "最近", icon: Clock, title: "最近访问" },
  { key: "groups", label: "组", icon: FolderTree, title: "按资产组" },
  { key: "tags", label: "标签", icon: Tag, title: "按标签" },
  { key: "protocols", label: "协议", icon: Network, title: "按协议" },
  { key: "all", label: "全部", icon: ListChecks, title: "全部可见资产" },
]

export function AssetTreeViewSwitcher({
  value,
  onChange,
}: {
  value: TreeView
  onChange: (v: TreeView) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="资产树视图"
      className="grid grid-cols-6 gap-0.5 p-1 mx-2 mt-2 mb-1 rounded-md bg-muted/40"
    >
      {ITEMS.map((it) => {
        const active = value === it.key
        const Icon = it.icon
        return (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={active}
            title={it.title}
            onClick={() => onChange(it.key)}
            className={cn(
              "flex flex-col items-center gap-0.5 py-1.5 rounded text-[10px] font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-card/60",
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{it.label}</span>
          </button>
        )
      })}
    </div>
  )
}
