"use client"

import * as React from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Waypoints } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WGIface, WGPeer } from "@/lib/api/services"
import { fmtBytes, HandshakeBadge, handshakeAge, peerOnline, useElementWidth } from "./shared"

// WgTopology draws the interface as a hub with its peers radiating around it.
// Edge colour = handshake freshness; edge animates while the peer is online;
// edge width scales (log) with traffic. Positions are a pure function of the
// sorted peer keys, so live SSE updates restyle without moving nodes.

interface HubData extends Record<string, unknown> {
  iface: WGIface
}
interface PeerData extends Record<string, unknown> {
  peer: WGPeer
  onClick?: (pub: string) => void
}

function HubNode({ data }: NodeProps) {
  const ifc = (data as HubData).iface
  return (
    <div className="rounded-xl border bg-card px-3 py-2.5 shadow-none">
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />
      <div className="flex items-center gap-1.5">
        <Waypoints className="h-4 w-4 text-primary" />
        <span className="font-mono text-xs font-medium">{ifc.name}</span>
        {ifc.listen_port > 0 && <span className="text-[10px] text-muted-foreground">:{ifc.listen_port}</span>}
      </div>
      {(ifc.addresses ?? []).length > 0 && (
        <div className="mt-0.5 max-w-[150px] truncate font-mono text-[10px] text-muted-foreground">
          {(ifc.addresses ?? []).join(", ")}
        </div>
      )}
      <div className="mt-0.5 text-[10px] text-muted-foreground">{(ifc.peers ?? []).length} 对端</div>
    </div>
  )
}

function PeerNode({ data }: NodeProps) {
  const d = data as PeerData
  const p = d.peer
  const online = peerOnline(p.latest_handshake)
  const stale = !online && p.latest_handshake > 0 && Math.floor(Date.now() / 1000) - p.latest_handshake < 600
  const ips = p.allowed_ips ?? []
  return (
    <button
      type="button"
      onClick={() => d.onClick?.(p.public_key)}
      className={cn(
        "w-[150px] rounded-lg border bg-card px-2.5 py-2 text-left transition-colors hover:border-primary/40",
        online && "border-success/40 bg-success/[0.06]",
        stale && "border-warning/40 bg-warning/[0.06]",
        !online && !stale && "opacity-70",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
      <div className="truncate font-mono text-[10px] font-medium" title={p.public_key}>{p.public_key.slice(0, 14)}…</div>
      {ips.length > 0 && <div className="truncate font-mono text-[10px] text-muted-foreground" title={ips.join(", ")}>{ips[0]}</div>}
      <div className="mt-0.5 flex items-center justify-between gap-1 text-[9px]">
        <HandshakeBadge ts={p.latest_handshake} />
        <span className="font-mono text-muted-foreground">↓{fmtBytes(p.transfer_rx)} ↑{fmtBytes(p.transfer_tx)}</span>
      </div>
    </button>
  )
}

const NODE_TYPES = { wghub: HubNode, wgpeer: PeerNode }

function edgeWidth(bytes: number): number {
  if (bytes <= 0) return 1.2
  return Math.max(1.2, Math.min(4, 1 + Math.log10(bytes) / 2.5))
}
function edgeColor(ts: number): string {
  const { tone } = handshakeAge(ts)
  if (tone.includes("success")) return "var(--success)"
  if (tone.includes("warning")) return "var(--warning)"
  if (tone.includes("destructive")) return "var(--destructive)"
  return "var(--border)"
}

function buildGraph(iface: WGIface, onPeerClick?: (pub: string) => void): { nodes: Node[]; edges: Edge[] } {
  const peers = [...(iface.peers ?? [])].sort((a, b) => a.public_key.localeCompare(b.public_key))
  const n = peers.length
  const radius = Math.min(300, Math.max(150, 90 + n * 16))
  const nodes: Node[] = [
    { id: "hub", type: "wghub", position: { x: 0, y: 0 }, data: { iface } as HubData, draggable: false },
  ]
  const edges: Edge[] = []
  peers.forEach((p, i) => {
    const angle = (-90 + i * (360 / Math.max(1, n))) * (Math.PI / 180)
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    const id = `peer-${p.public_key}`
    nodes.push({ id, type: "wgpeer", position: { x, y }, data: { peer: p, onClick: onPeerClick } as PeerData })
    edges.push({
      id: `hub-${id}`,
      source: "hub",
      target: id,
      animated: peerOnline(p.latest_handshake),
      style: { stroke: edgeColor(p.latest_handshake), strokeWidth: edgeWidth(p.transfer_rx + p.transfer_tx) },
    })
  })
  return { nodes, edges }
}

function TopologyFlow({ iface, onPeerClick }: { iface: WGIface; onPeerClick?: (pub: string) => void }) {
  const graph = React.useMemo(() => buildGraph(iface, onPeerClick), [iface, onPeerClick])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(graph.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(graph.edges)
  // Positions are deterministic per sorted peer-key set, so re-syncing every SSE
  // tick restyles edges/labels without nodes jumping around.
  React.useEffect(() => {
    setNodes(graph.nodes)
    setEdges(graph.edges)
  }, [graph, setNodes, setEdges])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES}
      nodesConnectable={false}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      className="bg-transparent"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="opacity-50" />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

// TopologyList is the narrow-panel fallback (no canvas): a hub line + one row
// per peer. Keeps the live read without a cramped graph.
function TopologyList({ iface, onPeerClick }: { iface: WGIface; onPeerClick?: (pub: string) => void }) {
  const peers = iface.peers ?? []
  return (
    <div className="h-full overflow-auto p-2">
      <div className="mb-1 flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5">
        <Waypoints className="h-3.5 w-3.5 text-primary" />
        <span className="font-mono text-xs font-medium">{iface.name}</span>
        <span className="text-[10px] text-muted-foreground">{peers.length} 对端</span>
      </div>
      <div className="space-y-1">
        {peers.map((p) => (
          <button
            key={p.public_key}
            type="button"
            onClick={() => onPeerClick?.(p.public_key)}
            className="flex w-full items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left"
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", peerOnline(p.latest_handshake) ? "bg-success" : "bg-muted-foreground/40")} />
            <span className="min-w-0 flex-1 truncate font-mono text-[10px]" title={p.public_key}>{p.public_key.slice(0, 16)}…</span>
            <HandshakeBadge ts={p.latest_handshake} className="text-[10px]" />
          </button>
        ))}
        {peers.length === 0 && <div className="px-2 py-4 text-center text-xs text-muted-foreground">无对端</div>}
      </div>
    </div>
  )
}

export function WgTopology({ iface, onPeerClick }: { iface: WGIface; onPeerClick?: (pub: string) => void }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  return (
    <div ref={ref} className="relative h-[min(380px,46vh)] w-full overflow-hidden rounded-lg border bg-muted/20">
      {width > 0 && width < 360 ? (
        <TopologyList iface={iface} onPeerClick={onPeerClick} />
      ) : (
        <ReactFlowProvider>
          <TopologyFlow iface={iface} onPeerClick={onPeerClick} />
        </ReactFlowProvider>
      )}
    </div>
  )
}
