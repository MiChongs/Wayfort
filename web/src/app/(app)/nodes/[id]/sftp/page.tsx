"use client"

import { use } from "react"
import { SftpWorkspace } from "@/components/sftp/SftpWorkspace"

// Thin wrapper around the reusable SftpWorkspace component. The same component
// is also embedded as a tab inside /workspace, which is why all the state /
// mutation / modal plumbing lives there instead of here.
export default function SFTPPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <SftpWorkspace nodeId={Number(id)} showNodeHeader />
}
