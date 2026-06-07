"use client"

import { use } from "react"
import { OssWorkspace } from "@/components/oss/OssWorkspace"

// Thin wrapper around the reusable OssWorkspace component. The same component is
// also embedded as a tab inside /workspace; all state / mutation / dialog
// plumbing lives in the component, not here.
export default function OSSPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <OssWorkspace nodeId={Number(id)} className="h-[calc(100vh-3.5rem)] flex" />
}
