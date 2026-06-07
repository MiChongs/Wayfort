"use client"

import * as React from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

// Keyboard reference. Lifted out of WorkspaceShell so the shell stays an
// orchestration file. The bindings mirror WorkspaceShortcuts + the tab strip.
const SHORTCUTS: [string, string][] = [
  ["Ctrl / ⌘  T", "新建会话（命令面板）"],
  ["Ctrl / ⌘  W", "关闭当前会话"],
  ["Ctrl / ⌘  ⇧ T", "撤销关闭"],
  ["Ctrl  Tab", "下一个会话"],
  ["Ctrl  ⇧ Tab", "上一个会话"],
  ["Ctrl / ⌘  1…9", "跳到第 N 个会话"],
  ["Ctrl / ⌘  K", "命令面板"],
  ["Ctrl / ⌘  B", "切换侧边栏"],
  ["Ctrl / ⌘  \\", "分屏 / 取消分屏"],
  ["F11", "当前会话全屏"],
  ["双击标签", "重命名"],
  ["中键 / Ctrl W", "关闭标签"],
]

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="display-title text-xl">键盘快捷键</DialogTitle>
        <div className="-mx-1 mt-1 divide-y divide-border/60">
          {SHORTCUTS.map(([combo, desc]) => (
            <div key={combo} className="flex items-center justify-between gap-4 px-1 py-2">
              <span className="text-sm text-muted-foreground">{desc}</span>
              <kbd className="shrink-0 rounded-md border bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground/80">
                {combo}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
