"use client"
import { use } from "react"
import { useQuery } from "@tanstack/react-query"
// Plan 15: switched from GuacamoleDisplay → RDPDisplay (PixiJS WebGL
// renderer + record/screenshot/annotation/minimap/stats plugins).
// The protocol layer is still guacd; only the user-visible surface and
// the feature toolbar change.
import { RDPDisplay } from "@/components/rdp/rdp-display"
import { nodeService } from "@/lib/api/services"

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const node = useQuery({
    queryKey: ["node", nodeId],
    queryFn: () => nodeService.get(nodeId),
  })
  return (
    <div className="h-[calc(100vh-56px)]">
      <RDPDisplay
        protocol="rdp"
        nodeId={nodeId}
        nodeName={node.data?.name}
        nodeHost={node.data?.host}
        nodePort={node.data?.port}
        backHref={`/nodes/${nodeId}`}
      />
    </div>
  )
}
