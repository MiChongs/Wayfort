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
  const setLatency = useWorkspaceStore((s) => s.setLatency)
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

  // DesktopDisplay (rdp_next) drives the same Tab status pipeline as
  // WebSSH. The DesktopStatus enum is finer-grained than TabStatus, so
  // we collapse the connection-in-progress states down to "connecting"
  // and the terminal states to "closed"/"error" — the inner viewer
  // shows the precise phase in its own loading overlay.
  const onDesktopStatusChange = React.useCallback(
    (s: "loading-script" | "connecting" | "handshake" | "connected" | "reconnecting" | "closed" | "error") => {
      if (s === "connected") setStatus(tab.id, "connected")
      else if (s === "error") setStatus(tab.id, "error")
      else if (s === "closed") setStatus(tab.id, "closed")
      else setStatus(tab.id, "connecting")
    },
    [setStatus, tab.id],
  )

  // RTT badge. `null` means the renderer can't measure latency for this
  // session (e.g. IronRDP Wasm path) — the badge renders a dash. Wiping
  // happens when the renderer reports null on disconnect.
  const onDesktopLatency = React.useCallback(
    (ms: number | null) => {
      setLatency(tab.id, ms)
    },
    [setLatency, tab.id],
  )

  // Non-WS protocols that *do* push status (rdp_next via DesktopDisplay)
  // are driven by their own callbacks below — don't pre-set them here
  // or we race the callback. Protocols without callbacks (rdp/vnc on
  // the legacy Guacamole path; sftp; tcp_forward) still need this
  // bootstrap so the tab dot doesn't stick at "fresh".
  React.useEffect(() => {
    if (tab.protocol === "sftp" || tab.protocol === "tcp_forward") {
      setStatus(tab.id, "connected")
      return
    }
    if (tab.protocol === "rdp" || tab.protocol === "vnc") {
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
            onStatusChange={onDesktopStatusChange}
            onLatencyChange={onDesktopLatency}
          />
        </SideDock>
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
              <TabBody tab={tab} />
            </div>
          )
        })
      )}
    </div>
  )
}
