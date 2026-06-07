"use client"

import * as React from "react"
import {
  Command as CommandIcon,
  HardDrive,
  Keyboard as KeyboardIcon,
  Maximize,
  Plug,
  RotateCw,
  Send,
  Settings as SettingsIcon,
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
import { PRESET_COMBOS } from "./desktop-key-map"

export interface DesktopCommandActions {
  onSendCombo: (combo: string) => void
  onFullscreen: () => void
  onFiles?: () => void
  onSettings: () => void
  onReconnect: () => void
  onDisconnect: () => void
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: DesktopCommandActions
}

export function DesktopCommandPalette({ open, onOpenChange, actions }: Props) {
  function run(fn: () => void) {
    return () => {
      onOpenChange(false)
      requestAnimationFrame(fn)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>桌面命令面板</DialogTitle>
          <DialogDescription>模糊搜索任何动作</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder="输入命令名或描述…" />
          <CommandList>
            <CommandEmpty>无匹配命令</CommandEmpty>

            <CommandGroup heading="键盘组合">
              {PRESET_COMBOS.map((c) => (
                <CommandItem
                  key={c.combo}
                  onSelect={run(() => actions.onSendCombo(c.combo))}
                  className="text-sm"
                >
                  <Send className="w-4 h-4" />
                  <span className="font-mono">{c.label}</span>
                  {c.hint && (
                    <span className="ml-auto text-[10px] text-muted-foreground">{c.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading="视图">
              <Item icon={Maximize} label="切换全屏" hint="F11" onSelect={run(actions.onFullscreen)} />
              {actions.onFiles && (
                <Item icon={HardDrive} label="文件传输 / 个人盘" onSelect={run(actions.onFiles)} />
              )}
              <Item icon={SettingsIcon} label="打开桌面设置" onSelect={run(actions.onSettings)} />
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading="会话">
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

// Keep these icons re-exported so consumers can keep a single import path.
export { CommandIcon, KeyboardIcon }
