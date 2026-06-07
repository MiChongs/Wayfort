"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { Group, Panel, Separator } from "react-resizable-panels"
import type { Node } from "@/lib/api/types"
import type { DesktopBackend } from "@/lib/desktop/types"
import { ActivityBar } from "./ActivityBar"
import { SidePanel } from "./SidePanel"
import { NewTabLauncher } from "./NewTabLauncher"
import { WorkspaceShortcuts } from "./WorkspaceShortcuts"
import { WorkspaceStatusBar } from "./WorkspaceStatusBar"
import { WorkspaceTabBar } from "./WorkspaceTabBar"
import { WorkspaceTabContent } from "./WorkspaceTabContent"
import { WorkspaceWelcome } from "./WorkspaceWelcome"
import { WorkspacePopout } from "./WorkspacePopout"
import { ShortcutsDialog } from "./dialogs/ShortcutsDialog"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

// Top-level workspace orchestration. The chrome is a VS Code-style shell:
//   [ activity bar (fixed) ][ side panel (resizable) | tab area ]
//                          + status bar at the foot.
// The activity bar lives OUTSIDE the resizable Group so it never resizes; the
// side panel keeps the existing Panel/Separator pattern, gated on sidebarOpen.
export function WorkspaceShell() {
  const searchParams = useSearchParams()
  const popoutTabId = searchParams.get("popout") === "1" ? searchParams.get("tab") : null
  const tabs = useWorkspaceStore((s) => s.tabs)
  const open = useWorkspaceStore((s) => s.open)
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen)
  const [launcherOpen, setLauncherOpen] = React.useState(false)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)

  // Declared before the popout early-return so hook order is stable across the
  // single-tab popout view and the full shell.
  const openTabFromTree = React.useCallback(
    (node: Node, protocol: Protocol, rdpBackend?: DesktopBackend) => {
      open({
        nodeId: node.id,
        protocol,
        rdpBackend,
        title: node.name,
        host: node.host,
        port: node.port,
      })
    },
    [open],
  )

  if (popoutTabId) {
    return <WorkspacePopout tabId={popoutTabId} />
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <ActivityBar
          onOpenLauncher={() => setLauncherOpen(true)}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />
        <div className="min-h-0 flex-1">
          <Group orientation="horizontal" className="h-full">
            {sidebarOpen && (
              <>
                <Panel
                  id="side"
                  defaultSize="22%"
                  minSize="14%"
                  maxSize="40%"
                  className="border-r bg-sidebar"
                >
                  <SidePanel onOpenTab={openTabFromTree} />
                </Panel>
                <Separator className="w-1 bg-border/30 transition-colors hover:bg-primary/50" />
              </>
            )}
            <Panel id="main" defaultSize="78%" minSize="40%">
              <div className="flex h-full min-h-0 flex-col">
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
      </div>
      <WorkspaceStatusBar />
      <WorkspaceShortcuts onNewTab={() => setLauncherOpen(true)} />
      <NewTabLauncher open={launcherOpen} onOpenChange={setLauncherOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  )
}
