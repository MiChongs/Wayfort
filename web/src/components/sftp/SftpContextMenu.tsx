"use client"

import * as React from "react"
import {
  Copy,
  Download,
  Edit2,
  Eye,
  FileArchive,
  Files,
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
  onArchive: (e: SftpEntry) => void
  onPreview: (e: SftpEntry) => void
  onEdit: (e: SftpEntry) => void
  onRename: (e: SftpEntry) => void
  onDuplicate: (e: SftpEntry) => void
  onChmod: (e: SftpEntry) => void
  onProperties: (e: SftpEntry) => void
  onDelete: (e: SftpEntry) => void
  onCopyPath: (e: SftpEntry) => void
}

type Props = {
  entry: SftpEntry
  actions: SftpContextActions
  onBeforeOpen?: (entry: SftpEntry) => void
  children: React.ReactNode
}

// Radix-backed row/card context menu. The trigger is asChild so it wraps a
// TableRow (list) or a card div (grid) without extra markup; keyboard nav,
// dismiss-on-Escape, and focus return all come from Radix.
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

        <ContextMenuItem disabled={!canPreview} onSelect={() => actions.onOpen(entry)}>
          <Eye className="h-4 w-4" />
          <span>{entry.is_dir ? "进入目录" : "预览"}</span>
          <ContextMenuShortcut>Enter</ContextMenuShortcut>
        </ContextMenuItem>
        {!entry.is_dir && (
          <ContextMenuItem disabled={!canEdit} onSelect={() => actions.onEdit(entry)}>
            <Edit2 className="h-4 w-4" />
            <span>编辑</span>
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        {!entry.is_dir && (
          <ContextMenuItem onSelect={() => actions.onDownload(entry)}>
            <Download className="h-4 w-4" />
            <span>下载</span>
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => actions.onArchive(entry)}>
          <FileArchive className="h-4 w-4" />
          <span>{entry.is_dir ? "打包下载（.tar.gz）" : "下载为 .tar.gz"}</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={() => actions.onRename(entry)}>
          <Pencil className="h-4 w-4" />
          <span>重命名</span>
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onDuplicate(entry)}>
          <Files className="h-4 w-4" />
          <span>创建副本</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onChmod(entry)}>
          <KeyRound className="h-4 w-4" />
          <span>修改权限</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={() => actions.onCopyPath(entry)}>
          <Copy className="h-4 w-4" />
          <span>复制路径</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onProperties(entry)}>
          <Info className="h-4 w-4" />
          <span>属性</span>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem variant="destructive" onSelect={() => actions.onDelete(entry)}>
          <Trash2 className="h-4 w-4" />
          <span>删除</span>
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
