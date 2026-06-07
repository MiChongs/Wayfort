"use client"

import * as React from "react"
import { RotateCcw, SplitSquareHorizontal, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspaceStore, type WorkspaceTab } from "./useWorkspaceStore"
import { useRuntimeStore } from "./useRuntimeStore"
import { metaOf } from "./protocolMeta"
import { STATUS_DOT, STATUS_TEXT, latencyTone } from "./tabStatus"

// Activity-bar panel that gives a bird's-eye view of every live session: a
// health summary, bulk actions, and one card per tab with quick activate /
// reconnect / split / close controls.
export function SessionOverviewPanel() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const setActive = useWorkspaceStore((s) => s.setActive)
  const close = useWorkspaceStore((s) => s.close)
  const setStatus = useWorkspaceStore((s) => s.setStatus)
  const setSplit = useWorkspaceStore((s) => s.setSplit)
  const reconnectAll = useWorkspaceStore((s) => s.reconnectAll)
  const closeErrored = useWorkspaceStore((s) => s.closeErrored)

  const connected = tabs.filter((t) => t.status === "connected").length
  const connecting = tabs.filter((t) => t.status === "connecting").length
  const errored = tabs.filter((t) => t.status === "error").length
  const approval = tabs.filter((t) => t.status === "approval").length

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex shrink-0 items-center justify-between px-3 pb-2 pt-3">
        <h2 className="text-sm font-semibold">会话总览</h2>
        <span className="text-[11px] text-muted-foreground">{tabs.length} 个</span>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-1.5 px-3 pb-2">
        <Stat label="在线" value={connected} tone={STATUS_TEXT.connected} />
        <Stat label="接入中" value={connecting} tone={STATUS_TEXT.connecting} />
        <Stat label="错误" value={errored} tone={errored ? "text-destructive" : "text-muted-foreground"} />
        <Stat label="待审批" value={approval} tone={approval ? STATUS_TEXT.connecting : "text-muted-foreground"} />
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
        <BulkButton onClick={reconnectAll} disabled={tabs.length === 0} icon={RotateCcw} label="全部重连" />
        <BulkButton onClick={closeErrored} disabled={errored === 0} icon={X} label="清理错误" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tabs.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted-foreground">还没有会话</div>
        ) : (
          <div className="flex flex-col gap-1">
            {tabs.map((tab) => (
              <SessionCard
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                onActivate={() => setActive(tab.id)}
                onReconnect={() => setStatus(tab.id, "connecting")}
                onClose={() => close(tab.id)}
                onSplit={() => setSplit(tab.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-baseline justify-between rounded-md border bg-card/40 px-2 py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-semibold tabular-nums", tone)}>{value}</span>
    </div>
  )
}

function BulkButton({
  onClick,
  disabled,
  icon: Icon,
  label,
}: {
  onClick: () => void
  disabled?: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  )
}

function SessionCard({
  tab,
  active,
  onActivate,
  onReconnect,
  onClose,
  onSplit,
}: {
  tab: WorkspaceTab
  active: boolean
  onActivate: () => void
  onReconnect: () => void
  onClose: () => void
  onSplit: () => void
}) {
  const meta = metaOf(tab.protocol)
  const Icon = meta.icon
  const ms = useRuntimeStore((s) => s.latency[tab.id])
  return (
    <div
      onClick={onActivate}
      className={cn(
        "group/card flex cursor-default items-center gap-2 rounded-md border px-2 py-1.5 transition-colors",
        active ? "border-primary/40 bg-primary/8" : "border-transparent hover:bg-accent/60",
      )}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted">
        <Icon className={cn("h-4 w-4", meta.tint)} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[tab.status])} />
          <span className="truncate text-[13px] font-medium">{tab.title}</span>
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {tab.host ?? meta.label}
          {tab.host && tab.port ? `:${tab.port}` : ""}
        </span>
      </span>
      {tab.status === "connected" && ms != null && (
        <span className={cn("shrink-0 text-[10px] tabular-nums", latencyTone(ms))}>{ms}ms</span>
      )}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100">
        <CardBtn title="重连" onClick={onReconnect}>
          <RotateCcw className="h-3.5 w-3.5" />
        </CardBtn>
        <CardBtn title="并排查看" onClick={onSplit}>
          <SplitSquareHorizontal className="h-3.5 w-3.5" />
        </CardBtn>
        <CardBtn title="关闭" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </CardBtn>
      </span>
    </div>
  )
}

function CardBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}
