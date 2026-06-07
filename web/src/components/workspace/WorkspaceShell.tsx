"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { Group, Panel, Separator } from "react-resizable-panels"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import type { Node } from "@/lib/api/types"
import type { DesktopBackend } from "@/lib/desktop/types"
import { cn } from "@/lib/utils"
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
import { metaOf, protocolChoicesForNode } from "./protocolMeta"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

// Top-level workspace orchestration. The chrome is a VS Code-style shell:
//   [ activity bar (fixed) ][ side panel (resizable) | tab area ]
//                          + status bar at the foot.
// A DndContext wraps everything so assets dragged from the tree can be dropped
// onto the session area to open them (see MainArea + onDragEnd).
export function WorkspaceShell() {
  const searchParams = useSearchParams()
  const popoutTabId = searchParams.get("popout") === "1" ? searchParams.get("tab") : null
  const tabs = useWorkspaceStore((s) => s.tabs)
  const open = useWorkspaceStore((s) => s.open)
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen)
  const protocolMemory = useWorkspaceStore((s) => s.protocolMemory)
  const [launcherOpen, setLauncherOpen] = React.useState(false)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const [dragNode, setDragNode] = React.useState<Node | null>(null)

  // 6px threshold so a click / double-click on a tree leaf still opens it; only
  // a real drag starts the DnD interaction.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Declared before the popout early-return so hook order is stable.
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

  const onDragStart = React.useCallback((e: DragStartEvent) => {
    setDragNode((e.active.data.current?.node as Node | undefined) ?? null)
  }, [])

  const onDragEnd = React.useCallback(
    (e: DragEndEvent) => {
      setDragNode(null)
      const node = e.active.data.current?.node as Node | undefined
      if (!node || e.over?.id !== "workspace-canvas") return
      // Default protocol: the node's remembered choice, else its first option.
      const choices = protocolChoicesForNode(node.protocol)
      const mem = protocolMemory[node.id]
      const choice =
        (mem && choices.find((c) => c.protocol === mem.protocol && c.rdpBackend === mem.rdpBackend)) ??
        choices[0]
      if (choice) openTabFromTree(node, choice.protocol, choice.rdpBackend)
    },
    [openTabFromTree, protocolMemory],
  )

  if (popoutTabId) {
    return <WorkspacePopout tabId={popoutTabId} />
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
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
              <MainArea>
                <WorkspaceTabBar onNewTab={() => setLauncherOpen(true)} />
                {tabs.length === 0 ? (
                  <WorkspaceWelcome onNewTab={() => setLauncherOpen(true)} />
                ) : (
                  <WorkspaceTabContent />
                )}
              </MainArea>
            </Panel>
          </Group>
        </div>
      </div>
      <WorkspaceStatusBar />
      <WorkspaceShortcuts onNewTab={() => setLauncherOpen(true)} />
      <NewTabLauncher open={launcherOpen} onOpenChange={setLauncherOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <DragOverlay dropAnimation={null}>
        {dragNode ? <AssetDragChip node={dragNode} /> : null}
      </DragOverlay>
    </DndContext>
  )
}

// Session area = the asset-drop target. Releasing an asset drag here opens it.
function MainArea({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "workspace-canvas" })
  return (
    <div ref={setNodeRef} className="relative flex h-full min-h-0 flex-col">
      {children}
      {isOver && (
        <div className="pointer-events-none absolute inset-0 z-30 m-1.5 rounded-lg border-2 border-dashed border-primary/60 bg-primary/5" />
      )}
    </div>
  )
}

function AssetDragChip({ node }: { node: Node }) {
  const proto = (protocolChoicesForNode(node.protocol)[0]?.protocol ?? "tcp_forward") as Protocol
  const meta = metaOf(proto)
  const Icon = meta.icon
  return (
    <div className="flex items-center gap-2 rounded-md border bg-popover px-2.5 py-1.5 text-sm shadow-md">
      <Icon className={cn("h-4 w-4", meta.tint)} />
      <span className="font-medium">{node.name}</span>
    </div>
  )
}
