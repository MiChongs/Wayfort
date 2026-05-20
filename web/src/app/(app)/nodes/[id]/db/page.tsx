"use client"

import { use } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { DBStudio } from "@/components/db/db-studio"

// Standalone /nodes/[id]/db route. The body is the reusable DBStudio
// component (also embedded inside the workspace tab — see
// WorkspaceTabContent.tsx → case "db_studio").
export default function DBStudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
        <Link
          href={`/workspace?node=${nodeId}`}
          className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-3 h-3" /> 工作台
        </Link>
      </div>
      <DBStudio nodeId={nodeId} className="flex-1 min-h-0" />
    </div>
  )
}
