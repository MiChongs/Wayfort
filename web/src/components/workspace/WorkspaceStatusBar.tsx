"use client"

import * as React from "react"
import { Clock, Layers, ShieldCheck, User } from "lucide-react"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { useWorkspaceStore } from "./useWorkspaceStore"
import { useRuntimeStore } from "./useRuntimeStore"
import { metaOf } from "./protocolMeta"
import { STATUS_DOT, STATUS_TEXT } from "./tabStatus"
import { fmt } from "@/lib/security/x7"
import { cn } from "@/lib/utils"

export function WorkspaceStatusBar() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const activeExpiry = useRuntimeStore((s) => (activeId ? s.expiry[activeId] : undefined))
  const requestRenew = useRuntimeStore((s) => s.requestRenew)
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
          <span className={cn("inline-flex shrink-0 items-center gap-1", STATUS_TEXT.connected)}>
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", STATUS_DOT.connected)} />
            {connected} 在线
          </span>
        )}
        {connecting > 0 && (
          <span className={cn("inline-flex shrink-0 items-center gap-1", STATUS_TEXT.connecting)}>
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", STATUS_DOT.connecting)} />
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
                  ? "text-warning"
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
                className="ml-1 rounded-md border border-warning/40 px-1.5 py-0.5 text-[11px] font-medium text-warning transition-colors hover:bg-warning/10"
              >
                续期
              </button>
            )}
          </span>
        )}
        <span className="inline-flex items-center gap-1" title="本会话全程审计录制">
          <ShieldCheck className="h-3.5 w-3.5 text-success" /> <span className="hidden sm:inline">审计中</span>
        </span>
        {me?.usr && (
          <span className="inline-flex items-center gap-1" title={me.usr}>
            <User className="h-3.5 w-3.5 text-muted-foreground/70" />
            <span className="hidden max-w-[120px] truncate sm:inline">{me.usr}</span>
          </span>
        )}
      </div>
    </footer>
  )
}

function Sep() {
  return <span className="inline-block h-3 w-px shrink-0 bg-border" aria-hidden />
}
