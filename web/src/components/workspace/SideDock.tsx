"use client"

import * as React from "react"
import { Group, Panel, Separator } from "react-resizable-panels"
import {
  Activity,
  Box,
  Clock,
  Cog,
  Cpu,
  Gauge,
  HardDrive,
  History,
  Info,
  Network,
  Package,
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  UsersRound,
  Zap,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { DashboardTab } from "./server/DashboardTab"
import { ServicesTab } from "./server/ServicesTab"
import { FirewallTab } from "./server/FirewallTab"
import { DockerTab } from "./server/DockerTab"
import { NodeInfoTab } from "./server/NodeInfoTab"
import { SessionsTab } from "./server/SessionsTab"
import { CommandRunnerTab } from "./server/CommandRunnerTab"
import { ProcessesTab } from "./server/ProcessesTab"
import { PerformanceTab } from "./server/PerformanceTab"
import { LogsTab } from "./server/LogsTab"
import { HardwareTab } from "./server/HardwareTab"
import { KernelTab } from "./server/KernelTab"
import { StorageTab } from "./server/StorageTab"
import { NetworkToolsTab } from "./server/NetworkTab"
import { CronTab } from "./server/CronTab"
import { PackagesTab } from "./server/PackagesTab"
import { UsersTab } from "./server/UsersTab"
import { SecurityTab } from "./server/SecurityTab"
import { useWorkspaceStore, type SubTab as SubTabKey } from "./useWorkspaceStore"

type Props = {
  tabId: string
  nodeId: number
  // Visible part of the tab — the live protocol component (terminal / desktop / etc).
  children: React.ReactNode
}

// Context handed to every dock subtab. Tools take what they need; standardising
// the shape lets the registry render them uniformly.
type DockCtx = { nodeId: number; tabId: string; active: boolean }

type DockTab = {
  key: SubTabKey
  label: string
  group: string
  icon: React.ComponentType<{ className?: string }>
  render: (ctx: DockCtx) => React.ReactNode
}

// The ops dock registry. Grouped for the vertical rail; entries are added as
// each category lands (Wave by Wave). The active subtab is the only one
// mounted, matching the prior conditional-render behaviour.
const DOCK_TABS: DockTab[] = [
  // 观测
  { key: "dashboard", label: "仪表盘", group: "观测", icon: Gauge, render: ({ nodeId }) => <DashboardTab nodeId={nodeId} /> },
  { key: "processes", label: "进程", group: "观测", icon: Activity, render: ({ nodeId, tabId, active }) => <ProcessesTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "performance", label: "性能", group: "观测", icon: Zap, render: ({ nodeId, tabId, active }) => <PerformanceTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "logs", label: "日志", group: "观测", icon: ScrollText, render: ({ nodeId, tabId, active }) => <LogsTab nodeId={nodeId} tabId={tabId} active={active} /> },
  // 运行
  { key: "services", label: "服务", group: "运行", icon: Cog, render: ({ nodeId, active }) => <ServicesTab nodeId={nodeId} active={active} /> },
  { key: "docker", label: "Docker", group: "运行", icon: Box, render: ({ nodeId, tabId, active }) => <DockerTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "cron", label: "定时", group: "运行", icon: Clock, render: ({ nodeId, tabId, active }) => <CronTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "packages", label: "软件包", group: "运行", icon: Package, render: ({ nodeId, tabId, active }) => <PackagesTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "runner", label: "命令", group: "运行", icon: TerminalSquare, render: ({ nodeId, tabId, active }) => <CommandRunnerTab nodeId={nodeId} tabId={tabId} active={active} /> },
  // 系统
  { key: "network", label: "网络", group: "系统", icon: Network, render: ({ nodeId, tabId, active }) => <NetworkToolsTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "storage", label: "存储", group: "系统", icon: HardDrive, render: ({ nodeId, tabId, active }) => <StorageTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "kernel", label: "内核", group: "系统", icon: SlidersHorizontal, render: ({ nodeId, tabId, active }) => <KernelTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "hardware", label: "硬件", group: "系统", icon: Cpu, render: ({ nodeId, active }) => <HardwareTab nodeId={nodeId} active={active} /> },
  // 治理
  { key: "firewall", label: "防火墙", group: "治理", icon: Shield, render: ({ nodeId, active }) => <FirewallTab nodeId={nodeId} active={active} /> },
  { key: "users", label: "用户", group: "治理", icon: UsersRound, render: ({ nodeId, tabId, active }) => <UsersTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "security", label: "安全", group: "治理", icon: ShieldCheck, render: ({ nodeId, tabId, active }) => <SecurityTab nodeId={nodeId} tabId={tabId} active={active} /> },
  { key: "sessions", label: "会话", group: "治理", icon: History, render: ({ nodeId }) => <SessionsTab nodeId={nodeId} /> },
  { key: "info", label: "信息", group: "治理", icon: Info, render: ({ nodeId }) => <NodeInfoTab nodeId={nodeId} /> },
]

const GROUP_ORDER = ["观测", "运行", "系统", "治理"]

function groupedTabs(): { group: string; tabs: DockTab[] }[] {
  return GROUP_ORDER.map((g) => ({ group: g, tabs: DOCK_TABS.filter((t) => t.group === g) })).filter(
    (g) => g.tabs.length > 0,
  )
}

const DEFAULT_SUB: SubTabKey = "dashboard"

// SideDock wraps a live SSH connection with a right-side server-ops panel. The
// dock is collapsible (Panel-level); its active subtab is persisted per tab.
// Navigation is a grouped vertical icon rail so it scales to ~18 tools without
// overflowing the narrow dock.
export function SideDock({ tabId, nodeId, children }: Props) {
  const subRaw = useWorkspaceStore((s) => s.tabs.find((t) => t.id === tabId)?.subTab)
  const dockOpen = useWorkspaceStore((s) => s.tabs.find((t) => t.id === tabId)?.dockOpen ?? true)
  const setSubTab = useWorkspaceStore((s) => s.setSubTab)
  const toggleDock = useWorkspaceStore((s) => s.toggleDock)

  // Guard against a persisted subTab that no longer exists in the registry.
  const sub: SubTabKey = DOCK_TABS.some((t) => t.key === subRaw) ? (subRaw as SubTabKey) : DEFAULT_SUB
  const groups = React.useMemo(() => groupedTabs(), [])
  const activeTab = DOCK_TABS.find((t) => t.key === sub)

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel id={`${tabId}:main`} defaultSize="62%" minSize="30%">
        <div className="h-full relative">{children}</div>
      </Panel>
      <Separator className="w-1 bg-border/30 hover:bg-primary/50 transition-colors" />
      <Panel
        id={`${tabId}:dock`}
        defaultSize="38%"
        minSize={dockOpen ? "22%" : "3%"}
        maxSize={dockOpen ? "72%" : "3%"}
        className="bg-card"
      >
        {dockOpen ? (
          <div className="h-full flex min-h-0">
            {/* Grouped vertical icon rail */}
            <nav className="w-11 shrink-0 border-r flex flex-col overflow-y-auto py-1 bg-muted/20">
              <RailButton
                icon={PanelRightClose}
                label="折叠面板"
                onClick={() => toggleDock(tabId)}
              />
              {groups.map((g) => (
                <div key={g.group} className="mt-1.5">
                  <div className="px-1 pb-0.5 text-[8px] uppercase tracking-wide text-muted-foreground/60 text-center">
                    {g.group}
                  </div>
                  {g.tabs.map((t) => (
                    <RailButton
                      key={t.key}
                      icon={t.icon}
                      label={t.label}
                      active={sub === t.key}
                      onClick={() => setSubTab(tabId, t.key)}
                    />
                  ))}
                </div>
              ))}
            </nav>
            {/* Content */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="h-8 shrink-0 border-b flex items-center gap-1.5 px-3">
                {activeTab && <activeTab.icon className="w-3.5 h-3.5 text-muted-foreground" />}
                <span className="text-xs font-medium truncate">{activeTab?.label ?? "面板"}</span>
              </div>
              <div className="flex-1 min-h-0">
                {activeTab?.render({ nodeId, tabId, active: true })}
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center py-1">
            <RailButton icon={PanelRightOpen} label="展开服务器面板" onClick={() => toggleDock(tabId)} />
          </div>
        )}
      </Panel>
    </Group>
  )
}

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "relative mx-auto my-0.5 h-8 w-8 inline-flex items-center justify-center rounded-md transition-colors",
            active
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {active && (
            <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
          )}
          <Icon className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}
