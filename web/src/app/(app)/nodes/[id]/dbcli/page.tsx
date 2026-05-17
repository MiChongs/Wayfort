"use client"
import { use } from "react"
import { WebSSHTerminal } from "@/components/terminal/webssh-terminal"
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <div className="h-[calc(100vh-56px)]">
      <WebSSHTerminal protocol="dbcli" nodeId={Number(id)} />
    </div>
  )
}
