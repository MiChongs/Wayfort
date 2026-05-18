"use client"

import * as React from "react"
import {
  Command as CommandIcon,
  Keyboard as KeyboardIcon,
  Maximize,
  Plug,
  RotateCw,
  Settings as SettingsIcon,
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
import { PRESET_COMBOS } from "./desktop-key-map"

type Props = {
  children: React.ReactNode
  connected: boolean
  onSendCombo: (combo: string) => void
  onFullscreen: () => void
  onSettings: () => void
  onPalette: () => void
  onReconnect: () => void
  onDisconnect: () => void
}

export function DesktopContextMenu({
  children,
  connected,
  onSendCombo,
  onFullscreen,
  onSettings,
  onPalette,
  onReconnect,
  onDisconnect,
}: Props) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuLabel className="text-xs text-muted-foreground">远程桌面</ContextMenuLabel>
        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-xs">
            <KeyboardIcon className="w-3.5 h-3.5" /> 发送组合键
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            {PRESET_COMBOS.map((c) => (
              <ContextMenuItem
                key={c.combo}
                onSelect={() => onSendCombo(c.combo)}
                className="text-xs flex items-center gap-2"
              >
                <span className="font-mono">{c.label}</span>
                {c.hint && <span className="ml-auto text-muted-foreground">{c.hint}</span>}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuItem onSelect={onFullscreen} className="text-xs">
          <Maximize className="w-3.5 h-3.5" /> 全屏
          <ContextMenuShortcut>F11</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onSettings} className="text-xs">
          <SettingsIcon className="w-3.5 h-3.5" /> 桌面设置…
        </ContextMenuItem>
        <ContextMenuItem onSelect={onPalette} className="text-xs">
          <CommandIcon className="w-3.5 h-3.5" /> 命令面板…
          <ContextMenuShortcut>⌃⇧P</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSeparator />

        {connected ? (
          <ContextMenuItem onSelect={onDisconnect} className="text-xs text-red-500">
            <Plug className="w-3.5 h-3.5" /> 断开连接
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={onReconnect} className="text-xs text-emerald-500">
            <RotateCw className="w-3.5 h-3.5" /> 重新连接
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
