"use client"

import * as React from "react"
import {
  AArrowDown,
  AArrowUp,
  Bell,
  BellOff,
  Clipboard,
  Copy,
  Download,
  Eraser,
  FolderTree,
  Maximize,
  Palette,
  Plug,
  RotateCw,
  Search as SearchIcon,
  Send,
  Settings as SettingsIcon,
  Zap,
} from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TERMINAL_THEMES, TERMINAL_THEME_ORDER, type TerminalThemeName } from "./terminal-themes"

export interface TerminalCommandActions {
  onCopy: () => void
  onPaste: () => void
  onSearch: () => void
  onClear: () => void
  onExport: () => void
  onSettings: () => void
  onFontInc: () => void
  onFontDec: () => void
  onFontReset: () => void
  onFullscreen: () => void
  onToggleBell: () => void
  bellEnabled: boolean
  onSendSignal: (ctrlChar: string) => void
  onReconnect: () => void
  onDisconnect: () => void
  onOpenSftp?: () => void
  onSelectTheme: (name: TerminalThemeName) => void
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: TerminalCommandActions
}

export function TerminalCommandPalette({ open, onOpenChange, actions }: Props) {
  function run(fn: () => void) {
    return () => {
      onOpenChange(false)
      // Defer so the dialog closes first; otherwise the focus return-target
      // (xterm container) misses the rAF and re-focuses on the dialog.
      requestAnimationFrame(fn)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>终端命令面板</DialogTitle>
          <DialogDescription>模糊搜索任何动作</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="输入命令名或描述…" />
          <CommandList>
        <CommandEmpty>无匹配命令</CommandEmpty>

        <CommandGroup heading="编辑">
          <Item icon={Copy} label="复制选区" hint="Ctrl/⌘+Shift+C" onSelect={run(actions.onCopy)} />
          <Item icon={Clipboard} label="粘贴" hint="Ctrl/⌘+Shift+V" onSelect={run(actions.onPaste)} />
          <Item icon={SearchIcon} label="搜索" hint="Ctrl/⌘+Shift+F" onSelect={run(actions.onSearch)} />
          <Item icon={Eraser} label="清屏" onSelect={run(actions.onClear)} />
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="发送控制信号">
          <Item icon={Zap} label="Ctrl+C — 中断 (SIGINT)" onSelect={run(() => actions.onSendSignal("\x03"))} />
          <Item icon={Zap} label="Ctrl+D — EOF / 退出" onSelect={run(() => actions.onSendSignal("\x04"))} />
          <Item icon={Zap} label="Ctrl+Z — 挂起 (SIGTSTP)" onSelect={run(() => actions.onSendSignal("\x1a"))} />
          <Item icon={Zap} label="Ctrl+L — 清屏 (转义)" onSelect={run(() => actions.onSendSignal("\x0c"))} />
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="视图">
          <Item icon={AArrowUp} label="字号 +" onSelect={run(actions.onFontInc)} />
          <Item icon={AArrowDown} label="字号 −" onSelect={run(actions.onFontDec)} />
          <Item icon={AArrowUp} label="字号重置" onSelect={run(actions.onFontReset)} />
          <Item icon={Maximize} label="切换全屏" hint="F11" onSelect={run(actions.onFullscreen)} />
          <Item
            icon={actions.bellEnabled ? Bell : BellOff}
            label={actions.bellEnabled ? "关闭蜂鸣提示音" : "启用蜂鸣提示音"}
            onSelect={run(actions.onToggleBell)}
          />
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="主题">
          {TERMINAL_THEME_ORDER.map((name) => (
            <Item
              key={name}
              icon={Palette}
              label={TERMINAL_THEMES[name].display}
              hint={name}
              onSelect={run(() => actions.onSelectTheme(name))}
            />
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="会话">
          <Item icon={Download} label="导出当前会话为 .log" onSelect={run(actions.onExport)} />
          {actions.onOpenSftp && (
            <Item
              icon={FolderTree}
              label="在工作台打开 SFTP 文件管理"
              onSelect={run(actions.onOpenSftp)}
            />
          )}
          <Item icon={SettingsIcon} label="打开终端设置" onSelect={run(actions.onSettings)} />
          <Item icon={RotateCw} label="重新连接" onSelect={run(actions.onReconnect)} />
          <Item icon={Plug} label="断开连接" onSelect={run(actions.onDisconnect)} />
          </CommandGroup>
        </CommandList>
      </Command>
      </DialogContent>
    </Dialog>
  )
}

function Item({
  icon: Icon,
  label,
  hint,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  hint?: string
  onSelect: () => void
}) {
  return (
    <CommandItem onSelect={onSelect} className="text-sm">
      <Icon className="w-4 h-4" />
      <span>{label}</span>
      {hint && <span className="ml-auto text-[10px] text-muted-foreground font-mono">{hint}</span>}
    </CommandItem>
  )
}

// Re-export Send so the toolbar/main file can keep `lucide-react` imports minimal.
export { Send as SendIcon }
