"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { SftpWorkspace } from "@/components/sftp/SftpWorkspace"
import { TcpForwardPanel } from "./TcpForwardPanel"
import { useWorkspaceStore, type WorkspaceTab as TabModel } from "./useWorkspaceStore"

// Heavy / canvas-bearing protocol components — lazy so the workspace shell
// boots fast and we don't drag Guacamole / Pixi / xterm into the initial
// bundle. SSR off for everything below (they all touch window).
const WebSSHTerminal = dynamic(
  () => import("@/components/terminal/webssh-terminal").then((m) => m.WebSSHTerminal),
  { ssr: false, loading: () => <LoadingShim label="加载终端…" /> },
)
const RDPDisplay = dynamic(
  () => import("@/components/rdp/rdp-display").then((m) => m.RDPDisplay),
  { ssr: false, loading: () => <LoadingShim label="加载远程桌面…" /> },
)
const DesktopDisplay = dynamic(
  () => import("@/components/desktop/desktop-display").then((m) => m.DesktopDisplay),
  { ssr: false, loading: () => <LoadingShim label="加载 RDP (新栈)…" /> },
)

function LoadingShim({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      <Loader2 className="w-4 h-4 animate-spin mr-2" /> {label}
    </div>
  )
}

// Pick the right protocol component for a tab. Stays in this file so the
// renderer logic lives next to the visibility strategy.
function renderTabBody(tab: TabModel): React.ReactNode {
  switch (tab.protocol) {
    case "ssh":
    case "telnet":
    case "dbcli":
      return (
        <WebSSHTerminal
          protocol={tab.protocol}
          nodeId={tab.nodeId}
          displayName={tab.title}
          host={tab.host}
          port={tab.port}
        />
      )
    case "rdp":
    case "vnc":
      return (
        <RDPDisplay
          protocol={tab.protocol}
          nodeId={tab.nodeId}
          nodeName={tab.title}
          nodeHost={tab.host}
          nodePort={tab.port}
        />
      )
    case "rdp_next":
      return (
        <DesktopDisplay
          nodeId={tab.nodeId}
          nodeName={tab.title}
          nodeHost={tab.host}
          nodePort={tab.port}
        />
      )
    case "sftp":
      return <SftpWorkspace nodeId={tab.nodeId} showNodeHeader={false} className="h-full flex flex-col" />
    case "tcp_forward":
      return <TcpForwardPanel nodeId={tab.nodeId} />
  }
}

// Canvas-bearing protocols can't tolerate display:none — Guacamole and the
// freerdp viewer stop receiving size events and may freeze. We keep them in
// the layout box but make them visually inert when inactive.
const CANVAS_PROTOS = new Set(["rdp", "vnc", "rdp_next"])

export function WorkspaceTabContent() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)

  return (
    <div className="relative flex-1 min-h-0 bg-background overflow-hidden">
      {tabs.length === 0 ? null : (
        tabs.map((tab) => {
          const active = tab.id === activeId
          const useVisibility = CANVAS_PROTOS.has(tab.protocol)
          return (
            <div
              key={tab.id}
              role="tabpanel"
              aria-hidden={!active}
              aria-label={tab.title}
              hidden={!active && !useVisibility}
              style={
                useVisibility
                  ? {
                      // Background canvas tabs stay laid out so RDP/VNC keep
                      // their server dimensions; just hidden and inert.
                      visibility: active ? "visible" : "hidden",
                      pointerEvents: active ? "auto" : "none",
                    }
                  : undefined
              }
              className={cn("absolute inset-0", active ? "z-10" : "z-0")}
            >
              {renderTabBody(tab)}
            </div>
          )
        })
      )}
    </div>
  )
}
