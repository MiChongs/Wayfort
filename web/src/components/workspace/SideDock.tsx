"use client"

import * as React from "react"
import { Group, Panel, Separator } from "react-resizable-panels"
import { Box, Gauge, History, Info, Shield } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { DashboardTab } from "./server/DashboardTab"
import { FirewallTab } from "./server/FirewallTab"
import { DockerTab } from "./server/DockerTab"
import { NodeInfoTab } from "./server/NodeInfoTab"
import { SessionsTab } from "./server/SessionsTab"
import { useWorkspaceStore, type SubTab as SubTabKey } from "./useWorkspaceStore"

type Props = {
  tabId: string
  nodeId: number
  // Visible part of the tab — the live protocol component (terminal / desktop / etc).
  children: React.ReactNode
}

const SUBTABS: { key: SubTabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "dashboard", label: "仪表盘", icon: Gauge },
  { key: "firewall", label: "防火墙", icon: Shield },
  { key: "docker", label: "Docker", icon: Box },
  { key: "sessions", label: "会话", icon: History },
  { key: "info", label: "信息", icon: Info },
]

// SideDock wraps a live connection (terminal / desktop) with a right-side
// server-management panel. The dock is collapsible (Panel-level) and its
// active sub-tab is persisted per workspace tab.
export function SideDock({ tabId, nodeId, children }: Props) {
  const sub = useWorkspaceStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.subTab ?? "dashboard",
  )
  const dockOpen = useWorkspaceStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.dockOpen ?? true,
  )
  const setSubTab = useWorkspaceStore((s) => s.setSubTab)
  const toggleDock = useWorkspaceStore((s) => s.toggleDock)

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel id={`${tabId}:main`} defaultSize="62%" minSize="30%">
        <div className="h-full relative">{children}</div>
      </Panel>
      <Separator className="w-1 bg-border/30 hover:bg-primary/50 transition-colors" />
      <Panel
        id={`${tabId}:dock`}
        defaultSize="38%"
        minSize={dockOpen ? "20%" : "3%"}
        maxSize={dockOpen ? "70%" : "3%"}
        className="bg-card"
      >
        <div className="h-full flex flex-col">
          <div className="border-b flex items-center gap-1 px-1.5 py-1.5">
            <button
              type="button"
              onClick={() => toggleDock(tabId)}
              className={cn(
                "h-7 w-7 inline-flex items-center justify-center rounded-md",
                "hover:bg-accent text-muted-foreground hover:text-foreground",
              )}
              title={dockOpen ? "折叠服务器面板" : "展开服务器面板"}
            >
              <Gauge className="w-3.5 h-3.5" />
            </button>
            {dockOpen && (
              <Tabs
                value={sub}
                onValueChange={(v) => setSubTab(tabId, v as SubTabKey)}
                className="flex-1 min-w-0"
              >
                <TabsList className="h-7 w-full justify-start gap-0.5 p-0.5">
                  {SUBTABS.map((t) => {
                    const Icon = t.icon
                    return (
                      <TabsTrigger
                        key={t.key}
                        value={t.key}
                        className="h-6 text-[11px] px-2 gap-1"
                        title={t.label}
                      >
                        <Icon className="w-3 h-3" />
                        <span className="hidden xl:inline">{t.label}</span>
                      </TabsTrigger>
                    )
                  })}
                </TabsList>
              </Tabs>
            )}
          </div>
          {dockOpen && (
            <div className="flex-1 min-h-0">
              {sub === "dashboard" && <DashboardTab nodeId={nodeId} />}
              {sub === "firewall" && <FirewallTab nodeId={nodeId} active={sub === "firewall"} />}
              {sub === "docker" && <DockerTab nodeId={nodeId} active={sub === "docker"} />}
              {sub === "sessions" && <SessionsTab nodeId={nodeId} />}
              {sub === "info" && <NodeInfoTab nodeId={nodeId} />}
            </div>
          )}
        </div>
      </Panel>
    </Group>
  )
}
