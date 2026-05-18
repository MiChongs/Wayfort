"use client"

import * as React from "react"
import { Group, Panel, Separator } from "react-resizable-panels"
import type { Node } from "@/lib/api/types"
import { AssetTree } from "./AssetTree"
import { NewTabLauncher } from "./NewTabLauncher"
import { WorkspaceMenubar } from "./WorkspaceMenubar"
import { WorkspaceShortcuts } from "./WorkspaceShortcuts"
import { WorkspaceStatusBar } from "./WorkspaceStatusBar"
import { WorkspaceTabBar } from "./WorkspaceTabBar"
import { WorkspaceTabContent } from "./WorkspaceTabContent"
import { WorkspaceWelcome } from "./WorkspaceWelcome"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

export function WorkspaceShell() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const open = useWorkspaceStore((s) => s.open)
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen)
  const [launcherOpen, setLauncherOpen] = React.useState(false)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)

  const openTabFromTree = React.useCallback(
    (node: Node, protocol: Protocol) => {
      open({
        nodeId: node.id,
        protocol,
        title: node.name,
        host: node.host,
        port: node.port,
      })
    },
    [open],
  )

  return (
    <>
      <WorkspaceMenubar
        onNewTab={() => setLauncherOpen(true)}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />
      <div className="flex-1 min-h-0">
        {/* v4: orientation="horizontal", percentage strings for sizes. */}
        <Group orientation="horizontal" className="h-full">
          {sidebarOpen && (
            <>
              <Panel id="tree" defaultSize="22%" minSize="14%" maxSize="40%" className="bg-sidebar border-r">
                <AssetTree onOpenTab={openTabFromTree} />
              </Panel>
              <Separator className="w-1 bg-border/30 hover:bg-primary/50 transition-colors" />
            </>
          )}
          <Panel id="main" defaultSize="78%" minSize="40%">
            <div className="h-full flex flex-col">
              <WorkspaceTabBar onNewTab={() => setLauncherOpen(true)} />
              {tabs.length === 0 ? (
                <WorkspaceWelcome onNewTab={() => setLauncherOpen(true)} />
              ) : (
                <WorkspaceTabContent />
              )}
            </div>
          </Panel>
        </Group>
      </div>
      <WorkspaceStatusBar />
      <WorkspaceShortcuts onNewTab={() => setLauncherOpen(true)} />
      <NewTabLauncher open={launcherOpen} onOpenChange={setLauncherOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  )
}

// Minimal "keyboard reference" modal. Lives inline to avoid yet another file.
function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-popover text-popover-foreground rounded-lg shadow-xl border w-[min(420px,calc(100vw-2rem))] p-5 space-y-3"
      >
        <h2 className="text-base font-semibold">键盘快捷键</h2>
        <table className="w-full text-sm">
          <tbody className="divide-y">
            {[
              ["Ctrl/⌘ + T", "新建 Tab（命令面板）"],
              ["Ctrl/⌘ + W", "关闭当前 Tab"],
              ["Ctrl/⌘ + Shift + T", "撤销关闭"],
              ["Ctrl + Tab", "下一个 Tab"],
              ["Ctrl + Shift + Tab", "上一个 Tab"],
              ["Ctrl/⌘ + 1..9", "跳到第 N 个 Tab"],
              ["Ctrl/⌘ + K", "命令面板（全局）"],
              ["Ctrl/⌘ + B", "切换侧边栏"],
              ["F11", "当前 Tab 全屏"],
              ["双击 Tab", "重命名"],
              ["中键 / Ctrl+W", "关闭 Tab"],
            ].map(([k, d]) => (
              <tr key={k}>
                <td className="py-1.5 pr-3">
                  <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">{k}</kbd>
                </td>
                <td className="py-1.5 text-muted-foreground">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end pt-1">
          <button
            type="button"
            className="text-sm px-3 py-1 rounded-md border hover:bg-accent"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
