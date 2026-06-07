"use client"

import * as React from "react"
import { Clock, Layers, ShieldCheck, User } from "lucide-react"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { useWorkspaceStore } from "./useWorkspaceStore"
import { metaOf } from "./protocolMeta"
import { fmt } from "@/lib/security/x7"
import { cn } from "@/lib/utils"

export function WorkspaceStatusBar() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const activeExpiry = useWorkspaceStore((s) => (s.activeId ? s.expiry[s.activeId] : undefined))
  const requestRenew = useWorkspaceStore((s) => s.requestRenew)
  const me = useCurrentUser()
  const active = tabs.find((t) => t.id === activeId)

  const total = tabs.length
  const connected = tabs.filter((t) => t.status === "connected").length
  const connecting = tabs.filter((t) => t.status === "connecting").length

  return (
    <footer className="flex shrink-0 select-none items-center justify-between gap-4 border-t bg-card/60 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-card/40">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 text-muted-foreground/70" />
          {total} 个会话
        </span>
        {connected > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[#4c9b62] dark:text-[#5db872]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#5db872]" />
            {connected} 在线
          </span>
        )}
        {connecting > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[#c08a2e] dark:text-[#e3b84e]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#d4a017] dark:bg-[#e3b84e]" />
            {connecting} 接入中
          </span>
        )}
        {active && (
          <>
            <Sep />
            <span className="min-w-0 truncate" title={active.title}>
              <span className="text-foreground/75">{active.title}</span>
              <span className="text-muted-foreground/70"> · {metaOf(active.protocol).label}</span>
              {active.host ? (
                <span className="font-mono text-muted-foreground/60">
                  {" "}
                  · {active.host}
                  {active.port ? `:${active.port}` : ""}
                </span>
              ) : null}
            </span>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {activeExpiry && activeId && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5",
              activeExpiry.ms <= 60_000
                ? "text-destructive"
                : activeExpiry.low
                  ? "text-[#c08a2e] dark:text-[#e3b84e]"
                  : "",
            )}
            title="本次访问到期后会自动断开，需重新申请"
          >
            <Clock className="h-3.5 w-3.5" />
            {fmt(activeExpiry.ms)} 后到期
            {activeExpiry.low && (
              <button
                type="button"
                onClick={() => requestRenew(activeId)}
                className="ml-1 rounded-md border border-[#d4a017]/40 px-1.5 py-0.5 text-[11px] font-medium text-[#c08a2e] transition-colors hover:bg-[#d4a017]/10 dark:text-[#e3b84e]"
              >
                续期
              </button>
            )}
          </span>
        )}
        <span className="inline-flex items-center gap-1" title="本会话全程审计录制">
          <ShieldCheck className="h-3.5 w-3.5 text-[#5db872]" /> 审计中
        </span>
        {me?.usr && (
          <span className="inline-flex items-center gap-1">
            <User className="h-3.5 w-3.5 text-muted-foreground/70" /> {me.usr}
          </span>
        )}
      </div>
    </footer>
  )
}

function Sep() {
  return <span className="inline-block h-3 w-px shrink-0 bg-border" aria-hidden />
}
