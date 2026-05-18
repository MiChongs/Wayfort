"use client"

import * as React from "react"
import { Activity, ShieldCheck, User } from "lucide-react"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { useWorkspaceStore } from "./useWorkspaceStore"
import { metaOf } from "./protocolMeta"

export function WorkspaceStatusBar() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const me = useCurrentUser()
  const active = tabs.find((t) => t.id === activeId)

  const total = tabs.length
  const connected = tabs.filter((t) => t.status === "connected").length
  const connecting = tabs.filter((t) => t.status === "connecting").length

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-1 border-t bg-muted/40 text-xs text-muted-foreground select-none shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center gap-1 shrink-0">
          <Activity className="w-3.5 h-3.5" />
          {total} 个 Tab
          {connected > 0 && (
            <span className="text-emerald-600 dark:text-emerald-400">· {connected} 已连接</span>
          )}
          {connecting > 0 && (
            <span className="text-amber-600 dark:text-amber-400">· {connecting} 连接中</span>
          )}
        </span>
        {active && (
          <span className="truncate font-mono opacity-70" title={active.title}>
            {metaOf(active.protocol).label}: {active.title}
            {active.host ? ` · ${active.host}${active.port ? `:${active.port}` : ""}` : ""}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" /> 审计中
        </span>
        {me?.usr && (
          <span className="inline-flex items-center gap-1">
            <User className="w-3.5 h-3.5" /> {me.usr}
          </span>
        )}
      </div>
    </div>
  )
}
