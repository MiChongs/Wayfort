"use client"

import * as React from "react"
import {
  Copy,
  Download,
  Edit2,
  Eye,
  Info,
  KeyRound,
  Pencil,
  Trash2,
} from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { SftpEntry } from "@/lib/api/services"
import { isEditable, isLikelyText, isPreviewableImage } from "./fileIcons"

export type SftpContextActions = {
  onOpen: (e: SftpEntry) => void
  onDownload: (e: SftpEntry) => void
  onPreview: (e: SftpEntry) => void
  onEdit: (e: SftpEntry) => void
  onRename: (e: SftpEntry) => void
  onChmod: (e: SftpEntry) => void
  onProperties: (e: SftpEntry) => void
  onDelete: (e: SftpEntry) => void
  onCopyPath: (e: SftpEntry) => void
}

type Props = {
  entry: SftpEntry
  actions: SftpContextActions
  // Fires on menu open (right-click) so the caller can select the row
  // before any action runs. Mirrors the old useSftpContextMenu behaviour.
  onBeforeOpen?: (entry: SftpEntry) => void
  children: React.ReactNode
}

// SftpRowContextMenu wraps a row element with a shadcn ContextMenu. Uses
// Radix under the hood so keyboard navigation, dismiss-on-Escape, and
// focus return all behave correctly without the manual event plumbing
// the old hand-rolled menu carried.
export function SftpRowContextMenu({ entry, actions, onBeforeOpen, children }: Props) {
  const canPreview = entry.is_dir || isLikelyText(entry) || isPreviewableImage(entry)
  const canEdit = isEditable(entry)

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) onBeforeOpen?.(entry)
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="truncate">{entry.name}</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!canPreview}
          onSelect={() => actions.onOpen(entry)}
        >
          <Eye className="w-4 h-4" />
          <span>{entry.is_dir ? "进入目录" : "预览"}</span>
          <ContextMenuShortcut>Enter</ContextMenuShortcut>
        </ContextMenuItem>
        {!entry.is_dir && (
          <ContextMenuItem disabled={!canEdit} onSelect={() => actions.onEdit(entry)}>
            <Edit2 className="w-4 h-4" />
            <span>编辑</span>
          </ContextMenuItem>
        )}
        {!entry.is_dir && (
          <ContextMenuItem onSelect={() => actions.onDownload(entry)}>
            <Download className="w-4 h-4" />
            <span>下载</span>
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => actions.onRename(entry)}>
          <Pencil className="w-4 h-4" />
          <span>重命名</span>
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onChmod(entry)}>
          <KeyRound className="w-4 h-4" />
          <span>改权限</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onProperties(entry)}>
          <Info className="w-4 h-4" />
          <span>属性</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onCopyPath(entry)}>
          <Copy className="w-4 h-4" />
          <span>复制路径</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => actions.onDelete(entry)}>
          <Trash2 className="w-4 h-4" />
          <span>删除</span>
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
