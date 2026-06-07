"use client"

// Standalone popout view. Opened via `window.open('/workspace?tab=…&popout=1')`
// from the WorkspaceTabBar ContextMenu. Renders only the single tab's
// content with a slim title bar, no sidebar, no tab strip — meant for
// "drag the SSH session onto the second monitor" workflows.

import * as React from "react"
import dynamic from "next/dynamic"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftToLine, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SftpWorkspace } from "@/components/sftp/SftpWorkspace"
import { nodeService } from "@/lib/api/services"
import { useWorkspaceStore } from "./useWorkspaceStore"
import { TcpForwardPanel } from "./TcpForwardPanel"
import { metaOf } from "./protocolMeta"

// Mirror the dynamic imports from WorkspaceTabContent so the popout
// window doesn't pull the entire workspace chrome into its initial bundle.
const WebSSHTerminal = dynamic(
  () => import("@/components/terminal/webssh-terminal").then((m) => m.WebSSHTerminal),
  { ssr: false, loading: () => <ShimLoader label="加载终端…" /> },
)
const RDPDisplay = dynamic(
  () => import("@/components/rdp/rdp-display").then((m) => m.RDPDisplay),
  { ssr: false, loading: () => <ShimLoader label="加载远程桌面…" /> },
)
const DesktopDisplay = dynamic(
  () => import("@/components/desktop/desktop-display").then((m) => m.DesktopDisplay),
  { ssr: false, loading: () => <ShimLoader label="加载 RDP…" /> },
)

function ShimLoader({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      <Loader2 className="w-4 h-4 animate-spin mr-2" /> {label}
    </div>
  )
}

interface Props {
  tabId: string
}

export function WorkspacePopout({ tabId }: Props) {
  const tab = useWorkspaceStore((s) => s.tabs.find((t) => t.id === tabId)) ?? null
  const setPoppedOut = useWorkspaceStore((s) => s.setPoppedOut)

  React.useEffect(() => {
    // When the popout window closes (user hits the X, or this component
    // unmounts via navigation), clear the popped-out marker in the main
    // window's store so the main UI resumes rendering the live view.
    return () => {
      if (tab) setPoppedOut(tab.id, false)
    }
  }, [setPoppedOut, tab])

  React.useEffect(() => {
    if (!tab) return
    const original = document.title
    document.title = `${tab.title} · ${metaOf(tab.protocol).label}`
    return () => {
      document.title = original
    }
  }, [tab])

  if (!tab) {
    return (
      <div className="h-screen flex items-center justify-center text-muted-foreground text-sm flex-col gap-2">
        <span>找不到要弹出的 Tab。可能已经在主窗口关闭。</span>
        <Button variant="outline" size="sm" onClick={() => window.close()}>
          关闭窗口
        </Button>
      </div>
    )
  }

  const Icon = metaOf(tab.protocol).icon
  return (
    <div className="h-screen flex flex-col bg-background">
      <div className="h-9 flex items-center gap-2 px-3 border-b text-sm bg-card/40">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="font-medium truncate">{tab.title}</span>
        {tab.host ? (
          <span className="text-muted-foreground font-mono text-xs truncate">
            {tab.host}
            {tab.port ? `:${tab.port}` : ""}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Bring the main window back into focus so the user can
              // resume editing the tab there. `window.opener.focus()` is
              // the safest way; close() lets the OS dispose this view.
              try {
                window.opener?.focus?.()
              } catch {
                /* opener may have closed */
              }
              window.close()
            }}
          >
            <ArrowLeftToLine className="w-3.5 h-3.5" /> 收回主窗口
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => window.close()}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <Body tab={tab} />
      </div>
    </div>
  )
}

function Body({ tab }: { tab: NonNullable<ReturnType<typeof useWorkspaceStore.getState>["tabs"][number]> }) {
  // Resolve the login user from the node record so the connect banner's
  // "登录用户" isn't blank in the popout window (mirrors WorkspaceTabContent).
  const needsUser = tab.protocol === "ssh" || tab.protocol === "telnet" || tab.protocol === "dbcli"
  const nodeQuery = useQuery({
    queryKey: ["node", tab.nodeId],
    queryFn: () => nodeService.get(tab.nodeId),
    enabled: needsUser && tab.nodeId > 0,
    staleTime: 5 * 60_000,
  })
  switch (tab.protocol) {
    case "ssh":
    case "telnet":
    case "dbcli":
      return (
        <WebSSHTerminal
          protocol={tab.protocol}
          nodeId={tab.nodeId}
          displayName={tab.title}
          username={nodeQuery.data?.username}
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
          backend={tab.rdpBackend}
        />
      )
    case "sftp":
      return <SftpWorkspace nodeId={tab.nodeId} showNodeHeader={false} className="h-full flex flex-col" />
    case "tcp_forward":
      return <TcpForwardPanel nodeId={tab.nodeId} />
  }
}
