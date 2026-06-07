"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { useQuery } from "@tanstack/react-query"
import { ArrowDownToLine, ExternalLink, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { nodeService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { SftpWorkspace } from "@/components/sftp/SftpWorkspace"
import { OssWorkspace } from "@/components/oss/OssWorkspace"
import { ApprovalGate } from "@/components/workspace/ApprovalGate"
import { SideDock } from "./SideDock"
import { TcpForwardPanel } from "./TcpForwardPanel"
import { useWorkspaceStore, type WorkspaceTab as TabModel } from "./useWorkspaceStore"
import { useRuntimeStore } from "./useRuntimeStore"
import { rectForSlot, isDraggableSplit, FULL_RECT, type SplitLayout } from "./lib/splitGeometry"

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
// Memoised so dragging the split divider (which re-renders WorkspaceTabContent
// on every pointer move) doesn't re-run the heavy per-protocol session bodies.
// The `tab` object reference is stable unless that tab actually changes.
const TabBody = React.memo(function TabBody({ tab }: { tab: TabModel }) {
  const setStatus = useWorkspaceStore((s) => s.setStatus)
  const setLatency = useRuntimeStore((s) => s.setLatency)
  const setPoppedOut = useWorkspaceStore((s) => s.setPoppedOut)
  const open = useWorkspaceStore((s) => s.open)

  // The SSH/telnet/dbcli login user lives on the node record, not on the tab
  // model — so the standalone pages pass `node.username` but the workspace
  // historically didn't, leaving the connect banner's "登录用户" blank. Resolve
  // it here from the (shared, cached) node detail query. Declared before the
  // poppedOut early-return so the hook order stays stable.
  const needsUser = tab.protocol === "ssh" || tab.protocol === "telnet" || tab.protocol === "dbcli"
  const nodeQuery = useQuery({
    queryKey: ["node", tab.nodeId],
    queryFn: () => nodeService.get(tab.nodeId),
    enabled: needsUser && tab.nodeId > 0,
    staleTime: 5 * 60_000,
  })
  const username = nodeQuery.data?.username

  // While the tab is showing in a standalone browser window, the main
  // window renders a placeholder instead of a second live renderer — two
  // simultaneous WS clients would compete for the same gateway session.
  if (tab.poppedOut) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <ExternalLink className="w-8 h-8 text-primary" />
        <div className="text-base font-medium text-foreground">已弹出到新窗口</div>
        <div className="text-xs">该 Tab 当前在独立浏览器窗口中运行。</div>
        <div className="flex items-center gap-2 pt-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => setPoppedOut(tab.id, false)}
          >
            <ArrowDownToLine className="w-3.5 h-3.5" /> 收回到主窗口
          </Button>
        </div>
      </div>
    )
  }

  // Wires WebSSHTerminal's internal Status → store TabStatus. Without this
  // the tab strip would show "未连接" forever even after the terminal had
  // connected (bug surfaced after PR #6 redesign — the dots are accurate
  // only if the protocol pushes status up to the store).
  const onSshStatusChange = React.useCallback(
    (s: "connecting" | "open" | "reconnecting" | "closed" | "error") => {
      setStatus(
        tab.id,
        s === "open" ? "connected" : s === "error" ? "error" : s === "closed" ? "closed" : "connecting",
      )
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
  // WebSSH. DesktopStatus is finer-grained than TabStatus, so collapse:
  //   connected/error/closed → same value; everything else → connecting.
  const onDesktopStatusChange = React.useCallback(
    (s: "loading-script" | "connecting" | "handshake" | "connected" | "reconnecting" | "closed" | "error") => {
      if (s === "connected") setStatus(tab.id, "connected")
      else if (s === "error") setStatus(tab.id, "error")
      else if (s === "closed") setStatus(tab.id, "closed")
      else setStatus(tab.id, "connecting")
    },
    [setStatus, tab.id],
  )

  // RTT badge. `null` means the renderer can't measure latency on this
  // session (e.g. IronRDP Wasm path) — the badge renders a dash.
  const onDesktopLatency = React.useCallback(
    (ms: number | null) => {
      setLatency(tab.id, ms)
    },
    [setLatency, tab.id],
  )

  // Non-WS protocols without a callback channel still need a bootstrap
  // status. rdp / vnc (Plan 15 Guacamole path) lack onStatusChange; sftp /
  // tcp_forward have no phase. rdp_next is driven by onDesktopStatusChange
  // below, so we skip it here to avoid racing the callback.
  React.useEffect(() => {
    if (
      tab.protocol === "sftp" ||
      tab.protocol === "oss" ||
      tab.protocol === "tcp_forward" ||
      tab.protocol === "db_studio"
    ) {
      setStatus(tab.id, "connected")
      return
    }
    if (tab.protocol === "rdp" || tab.protocol === "vnc") {
      setStatus(tab.id, "connecting")
    }
  }, [tab.id, tab.protocol, setStatus])

  // Connect-gated protocols pass through the approval gate: if the asset
  // requires approval and the user has no active grant, the tab shows the
  // request panel (apply + live status) instead of closing, then auto-connects
  // once approved. Browse-first protocols (sftp/oss/db_studio) are not gated at
  // open — their write operations enforce approval per-action.
  const body = (): React.ReactNode => {
    switch (tab.protocol) {
      // SSH is the only protocol that carries the Linux server-ops dock
      // (insights / firewall / docker / systemd / sessions / info). The dock's
      // telemetry is collected over an SSH exec channel against a Linux host, so
      // it's meaningless for telnet (no SSH), a DB CLI, a Windows desktop
      // (rdp/vnc/rdp_next) or the structured DB browser — those render the bare
      // session full-bleed.
      case "ssh":
        return (
          <SideDock tabId={tab.id} nodeId={tab.nodeId}>
            <WebSSHTerminal
              protocol={tab.protocol}
              nodeId={tab.nodeId}
              tabId={tab.id}
              displayName={tab.title}
              username={username}
              host={tab.host}
              port={tab.port}
              onStatusChange={onSshStatusChange}
              onOpenSftp={onOpenSftp}
            />
          </SideDock>
        )
      case "telnet":
      case "dbcli":
        return (
          <WebSSHTerminal
            protocol={tab.protocol}
            nodeId={tab.nodeId}
            displayName={tab.title}
            username={username}
            host={tab.host}
            port={tab.port}
            onStatusChange={onSshStatusChange}
            onOpenSftp={onOpenSftp}
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
            onStatusChange={onDesktopStatusChange}
            onLatencyChange={onDesktopLatency}
          />
        )
      case "sftp":
        return <SftpWorkspace nodeId={tab.nodeId} showNodeHeader={false} className="h-full flex flex-col" />
      case "oss":
        return <OssWorkspace nodeId={tab.nodeId} className="h-full flex flex-col" />
      case "tcp_forward":
        return <TcpForwardPanel nodeId={tab.nodeId} />
      case "db_studio":
        return <DBStudio nodeId={tab.nodeId} embedded />
    }
    return null
  }

  if (CONNECT_GATED.has(tab.protocol)) {
    return (
      <ApprovalGate
        tabId={tab.id}
        nodeId={tab.nodeId}
        nodeName={tab.title}
        nodeSubtitle={tab.host ? `${tab.protocol} · ${tab.host}${tab.port ? `:${tab.port}` : ""}` : tab.protocol}
        countdown={tab.protocol !== "tcp_forward"}
        onStateChange={(s) => {
          if (s === "approval") setStatus(tab.id, "approval")
          else if (s === "checking") setStatus(tab.id, "connecting")
        }}
      >
        {body()}
      </ApprovalGate>
    )
  }
  return body()
})

// Protocols whose tab open is blocked until an asset_access grant exists.
const CONNECT_GATED = new Set(["ssh", "telnet", "dbcli", "rdp", "vnc", "rdp_next", "tcp_forward"])

// Canvas-bearing protocols can't tolerate display:none — Guacamole and the
// freerdp viewer stop receiving size events and may freeze. We keep them in
// the layout box but make them visually inert when inactive.
const CANVAS_PROTOS = new Set(["rdp", "vnc", "rdp_next"])

export function WorkspaceTabContent() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const split = useWorkspaceStore((s) => s.split)
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  const multi = split.layout !== "single"
  // Slots drive the grid. Single view falls back to the active tab full-bleed.
  const slots = multi ? split.slots : activeId ? [activeId] : []

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
      {tabs.map((tab) => {
        const idx = slots.indexOf(tab.id)
        const visible = idx >= 0
        const isCanvas = CANVAS_PROTOS.has(tab.protocol)
        const style: React.CSSProperties = visible
          ? { ...rectForSlot(split.layout, idx, split.ratio), visibility: "visible", pointerEvents: "auto", zIndex: 10 }
          : isCanvas
            // Keepalive: stay laid out full-size but inert so RDP/VNC keep their
            // server dimensions and the WS connection survives in the background.
            ? { ...FULL_RECT, visibility: "hidden", pointerEvents: "none", zIndex: 0 }
            : { ...FULL_RECT, display: "none" }
        return (
          <div
            key={tab.id}
            role="tabpanel"
            aria-hidden={!visible}
            aria-label={tab.title}
            style={style}
            className={cn(
              "absolute",
              multi && idx === 0 && "rounded-sm ring-1 ring-inset ring-primary/35",
            )}
          >
            <TabBody tab={tab} />
          </div>
        )
      })}
      {/* Empty slots — a grid cell whose tab was closed. */}
      {multi &&
        slots.map((id, idx) =>
          id === null ? (
            <EmptySlot key={`empty-${idx}`} style={rectForSlot(split.layout, idx, split.ratio)} />
          ) : null,
        )}
      {multi && isDraggableSplit(split.layout) && (
        <SplitDivider containerRef={containerRef} layout={split.layout} ratio={split.ratio} />
      )}
    </div>
  )
}

function EmptySlot({ style }: { style: React.CSSProperties }) {
  return (
    <div
      style={style}
      className="absolute z-[5] m-1 flex items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10 text-xs text-muted-foreground"
    >
      会话已关闭
    </div>
  )
}

// Draggable divider for the two-pane layouts. Uses pointer capture so the drag
// keeps tracking even as the cursor passes over a terminal / canvas pane.
// row-2 = side-by-side (vertical handle); col-2 = stacked (horizontal handle).
function SplitDivider({
  containerRef,
  layout,
  ratio,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  layout: SplitLayout
  ratio: number
}) {
  const setSplitRatio = useWorkspaceStore((s) => s.setSplitRatio)
  const dragging = React.useRef(false)
  const isRow = layout === "row-2"
  return (
    <div
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        dragging.current = true
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        e.preventDefault()
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        const el = containerRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        setSplitRatio(isRow ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height)
      }}
      onPointerUp={(e) => {
        dragging.current = false
        ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      }}
      className={cn(
        "group absolute z-20 flex items-center justify-center",
        isRow ? "bottom-0 top-0 w-3 -translate-x-1/2 cursor-col-resize" : "left-0 right-0 h-3 -translate-y-1/2 cursor-row-resize",
      )}
      style={isRow ? { left: `${ratio * 100}%` } : { top: `${ratio * 100}%` }}
    >
      <span
        className={cn(
          "rounded-full bg-border transition-colors group-hover:bg-primary/60",
          isRow ? "h-10 w-[3px]" : "h-[3px] w-10",
        )}
      />
    </div>
  )
}
