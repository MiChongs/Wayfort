"use client"

import { use } from "react"
import { useQuery } from "@tanstack/react-query"
import { DesktopDisplay } from "@/components/desktop/desktop-display"
import { nodeService } from "@/lib/api/services"

// Plan 17 — new RDP frontend (Beta). Uses the DesktopWorker subprocess
// abstraction instead of guacd. M1 ships with the in-process "dummy"
// backend which paints a moving test pattern so we can verify the entire
// pipeline (control + WS + render-worker + input) before swapping in the
// real FreeRDP-linked worker in M2.
//
// `/nodes/[id]/rdp` (Plan 16, guacd) remains the default until M2 reaches
// feature parity; we go through Plan 19 to retire it.
export default function NodeRDPNextPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const node = useQuery({
    queryKey: ["node", nodeId],
    queryFn: () => nodeService.get(nodeId),
  })
  return (
    <div className="h-[calc(100vh-56px)]">
      <DesktopDisplay
        nodeId={nodeId}
        nodeName={node.data?.name}
        nodeHost={node.data?.host}
        nodePort={node.data?.port}
        backHref={`/nodes/${nodeId}`}
        // M1: keep dummy as the default so the page works on machines without
        // libfreerdp. Operators can flip to "freerdp" by editing this prop
        // (or once M2 ships, the gateway config sets the default backend).
        backend="dummy"
      />
    </div>
  )
}
