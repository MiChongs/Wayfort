"use client"

import { use } from "react"
import { useQuery } from "@tanstack/react-query"
import { WebSSHTerminal } from "@/components/terminal/webssh-terminal"
import { nodeService } from "@/lib/api/services"

export default function NodeSSHPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const node = useQuery({ queryKey: ["node", nodeId], queryFn: () => nodeService.get(nodeId) })
  return (
    <div className="h-[calc(100vh-56px)]">
      <WebSSHTerminal
        protocol="ssh"
        nodeId={nodeId}
        displayName={node.data?.name}
        username={node.data?.username}
        host={node.data?.host}
        port={node.data?.port}
      />
    </div>
  )
}
