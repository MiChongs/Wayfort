"use client"
import { use } from "react"
import { GuacamoleDisplay } from "@/components/guacamole/guac-display"
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <div className="h-[calc(100vh-56px)]">
      <GuacamoleDisplay protocol="rdp" nodeId={Number(id)} />
    </div>
  )
}
