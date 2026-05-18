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

type Pos = { x: number; y: number }
type State = { entry: SftpEntry; pos: Pos } | null

const MENU_W = 220
const ITEM_H = 30

// A lightweight floating context menu. The fully-fledged Radix ContextMenu
// component isn't installed in this repo, but a portal-positioned div plus
// click-outside / Escape handling does the job and avoids adding another
// Radix package.
export function SftpContextMenu({
  state,
  onClose,
  actions,
}: {
  state: State
  onClose: () => void
  actions: SftpContextActions
}) {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!state) return
    const onDown = (ev: MouseEvent) => {
      if (!ref.current?.contains(ev.target as Node)) onClose()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [state, onClose])

  if (!state) return null
  const { entry, pos } = state
  // Clamp to viewport — better than letting the menu spill off-screen.
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024
  const vh = typeof window !== "undefined" ? window.innerHeight : 768
  const itemCount = entry.is_dir ? 5 : 8
  const left = Math.min(pos.x, vw - MENU_W - 8)
  const top = Math.min(pos.y, vh - itemCount * ITEM_H - 8)

  const Item = ({
    icon: Icon,
    label,
    onClick,
    danger,
    disabled,
    accel,
  }: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    onClick: () => void
    danger?: boolean
    disabled?: boolean
    accel?: string
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        onClick()
        onClose()
      }}
      className={[
        "w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-left rounded-sm",
        "transition-colors",
        disabled
          ? "opacity-50 cursor-not-allowed"
          : danger
            ? "hover:bg-destructive/10 text-destructive"
            : "hover:bg-accent",
      ].join(" ")}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      {accel && <span className="text-xs text-muted-foreground">{accel}</span>}
    </button>
  )

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", left, top, width: MENU_W, zIndex: 60 }}
      className="bg-popover text-popover-foreground border rounded-md shadow-lg p-1 animate-in fade-in zoom-in-95"
    >
      <Item
        icon={entry.is_dir ? Eye : Eye}
        label={entry.is_dir ? "进入目录" : "预览"}
        onClick={() => actions.onOpen(entry)}
        accel="Enter"
        disabled={!entry.is_dir && !isLikelyText(entry) && !isPreviewableImage(entry)}
      />
      {!entry.is_dir && (
        <Item
          icon={Edit2}
          label="编辑"
          onClick={() => actions.onEdit(entry)}
          disabled={!isEditable(entry)}
        />
      )}
      {!entry.is_dir && (
        <Item icon={Download} label="下载" onClick={() => actions.onDownload(entry)} />
      )}
      <Item icon={Pencil} label="重命名" onClick={() => actions.onRename(entry)} accel="F2" />
      <Item icon={KeyRound} label="改权限" onClick={() => actions.onChmod(entry)} />
      <Item icon={Info} label="属性" onClick={() => actions.onProperties(entry)} />
      <Item icon={Copy} label="复制路径" onClick={() => actions.onCopyPath(entry)} />
      <Item
        icon={Trash2}
        label="删除"
        onClick={() => actions.onDelete(entry)}
        danger
        accel="Del"
      />
    </div>
  )
}

export function useSftpContextMenu() {
  const [state, setState] = React.useState<State>(null)
  const open = React.useCallback((entry: SftpEntry, ev: React.MouseEvent) => {
    ev.preventDefault()
    setState({ entry, pos: { x: ev.clientX, y: ev.clientY } })
  }, [])
  const close = React.useCallback(() => setState(null), [])
  return { state, open, close }
}
