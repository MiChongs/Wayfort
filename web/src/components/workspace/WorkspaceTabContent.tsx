"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { SftpWorkspace } from "@/components/sftp/SftpWorkspace"
import { SideDock } from "./SideDock"
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
const DBStudio = dynamic(
  () => import("@/components/db/db-studio").then((m) => m.DBStudio),
  { ssr: false, loading: () => <LoadingShim label="加载数据库浏览…" /> },
)

function LoadingShim({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      <Loader2 className="w-4 h-4 animate-spin mr-2" /> {label}
    </div>
  )
}

// TabBody is split out so it can read the workspace store hooks (setStatus
// / open) and forward them to the per-protocol component. The previous
// inline renderTabBody couldn't call hooks because it was a free function.
function TabBody({ tab }: { tab: TabModel }) {
  const setStatus = useWorkspaceStore((s) => s.setStatus)
  const open = useWorkspaceStore((s) => s.open)

  // Wires WebSSHTerminal's internal Status → store TabStatus. Without this
  // the tab strip would show "未连接" forever even after the terminal had
  // connected (bug surfaced after PR #6 redesign — the dots are accurate
  // only if the protocol pushes status up to the store).
  const onSshStatusChange = React.useCallback(
    (s: "connecting" | "open" | "closed") => {
      setStatus(tab.id, s === "open" ? "connected" : s === "closed" ? "closed" : "connecting")
    },
    [setStatus, tab.id],
  )

  // The terminal toolbar's SFTP shortcut opens a workspace tab instead of
  // navigating to /nodes/:id/sftp (which broke the workspace flow).
  const onOpenSftp = React.useCallback(() => {
    open({
      nodeId: tab.nodeId,
      protocol: "sftp",
      title: tab.title,
      host: tab.host,
      port: tab.port,
    })
  }, [open, tab.host, tab.nodeId, tab.port, tab.title])

  // Non-WS protocols don't have a clean phase signal yet — mark "connected"
  // once the body mounts so the tab dot stops sticking at "fresh". RDP /
  // VNC / Desktop expose their own internal phase UI inside the viewer for
  // real-time feedback; the workspace-level dot is a coarse summary.
  React.useEffect(() => {
    if (
      tab.protocol === "sftp" ||
      tab.protocol === "tcp_forward" ||
      tab.protocol === "db_studio"
    ) {
      setStatus(tab.id, "connected")
      return
    }
    if (tab.protocol === "rdp" || tab.protocol === "vnc" || tab.protocol === "rdp_next") {
      setStatus(tab.id, "connecting")
    }
  }, [tab.id, tab.protocol, setStatus])

  switch (tab.protocol) {
    case "ssh":
    case "telnet":
    case "dbcli":
      return (
        <SideDock tabId={tab.id} nodeId={tab.nodeId}>
          <WebSSHTerminal
            protocol={tab.protocol}
            nodeId={tab.nodeId}
            displayName={tab.title}
            host={tab.host}
            port={tab.port}
            onStatusChange={onSshStatusChange}
            onOpenSftp={onOpenSftp}
          />
        </SideDock>
      )
    case "rdp":
    case "vnc":
      return (
        <SideDock tabId={tab.id} nodeId={tab.nodeId}>
          <RDPDisplay
            protocol={tab.protocol}
            nodeId={tab.nodeId}
            nodeName={tab.title}
            nodeHost={tab.host}
            nodePort={tab.port}
          />
        </SideDock>
      )
    case "rdp_next":
      return (
        <SideDock tabId={tab.id} nodeId={tab.nodeId}>
          <DesktopDisplay
            nodeId={tab.nodeId}
            nodeName={tab.title}
            nodeHost={tab.host}
            nodePort={tab.port}
          />
        </SideDock>
      )
    case "sftp":
      return <SftpWorkspace nodeId={tab.nodeId} showNodeHeader={false} className="h-full flex flex-col" />
    case "tcp_forward":
      return <TcpForwardPanel nodeId={tab.nodeId} />
    case "db_studio":
      return (
        <SideDock tabId={tab.id} nodeId={tab.nodeId}>
          <DBStudio nodeId={tab.nodeId} embedded />
        </SideDock>
      )
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
              <TabBody tab={tab} />
            </div>
          )
        })
      )}
    </div>
  )
}
