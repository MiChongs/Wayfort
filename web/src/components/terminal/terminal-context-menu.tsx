"use client"

import * as React from "react"
import {
  Clipboard,
  Command as CommandIcon,
  Copy,
  Eraser,
  MousePointerSquareDashed,
  Search as SearchIcon,
  Send,
  Settings as SettingsIcon,
  Zap,
} from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

type Props = {
  children: React.ReactNode
  hasSelection: boolean
  onCopy: () => void
  onPaste: () => void
  onSelectAll: () => void
  onClear: () => void
  onSearch: () => void
  onSettings: () => void
  onPalette: () => void
  onSendSignal: (ctrlChar: string) => void
}

export function TerminalContextMenu({
  children,
  hasSelection,
  onCopy,
  onPaste,
  onSelectAll,
  onClear,
  onSearch,
  onSettings,
  onPalette,
  onSendSignal,
}: Props) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="text-xs text-muted-foreground">终端操作</ContextMenuLabel>
        <ContextMenuSeparator />

        <ContextMenuItem disabled={!hasSelection} onSelect={onCopy} className="text-xs">
          <Copy className="w-3.5 h-3.5" /> 复制
          <ContextMenuShortcut>⌃⇧C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onPaste} className="text-xs">
          <Clipboard className="w-3.5 h-3.5" /> 粘贴
          <ContextMenuShortcut>⌃⇧V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onSelectAll} className="text-xs">
          <MousePointerSquareDashed className="w-3.5 h-3.5" /> 全选
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onSearch} className="text-xs">
          <SearchIcon className="w-3.5 h-3.5" /> 搜索…
          <ContextMenuShortcut>⌃⇧F</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onClear} className="text-xs">
          <Eraser className="w-3.5 h-3.5" /> 清屏
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-xs">
            <Send className="w-3.5 h-3.5" /> 发送控制信号
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem onSelect={() => onSendSignal("\x03")} className="text-xs">
              <Zap className="w-3.5 h-3.5" /> Ctrl+C — 中断
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSendSignal("\x04")} className="text-xs">
              <Zap className="w-3.5 h-3.5" /> Ctrl+D — EOF
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSendSignal("\x1a")} className="text-xs">
              <Zap className="w-3.5 h-3.5" /> Ctrl+Z — 挂起
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onSendSignal("\x0c")} className="text-xs">
              <Zap className="w-3.5 h-3.5" /> Ctrl+L — 清屏
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onSettings} className="text-xs">
          <SettingsIcon className="w-3.5 h-3.5" /> 终端设置…
        </ContextMenuItem>
        <ContextMenuItem onSelect={onPalette} className="text-xs">
          <CommandIcon className="w-3.5 h-3.5" /> 命令面板…
          <ContextMenuShortcut>⌃⇧P</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
