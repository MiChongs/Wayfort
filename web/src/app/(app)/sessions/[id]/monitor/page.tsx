"use client"

import * as React from "react"
import { use } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Eye, Power, Radio } from "lucide-react"
import { sessionService } from "@/lib/api/services"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { toast } from "@/components/ui/sonner"
import { useAccess } from "@/lib/hooks/use-access"
import { kindMeta, fmtDuration } from "@/lib/session-meta"
import { TerminalMonitor } from "./terminal-monitor"
import { DesktopMonitor } from "./desktop-monitor"

// Read-only, full-screen "over-the-shoulder" monitor. Terminal sessions stream
// into a read-only xterm; desktop sessions into the production canvas pipeline.
// Both are watermarked-by-the-watched-session and audited server-side.
export default function SessionMonitor({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const access = useAccess()
  const canObserve = access.isSuperadmin || access.permissions.includes("session:observe")
  const canTerminate = access.isSuperadmin || access.permissions.includes("session:terminate")

  const sq = useQuery({ queryKey: ["session", id], queryFn: () => sessionService.get(id) })
  const s = sq.data?.session

  const [latency, setLatency] = React.useState<number | null>(null)
  const [ended, setEnded] = React.useState<string | null>(null)

  const onLatency = React.useCallback((ms: number) => setLatency(ms), [])
  const onClosed = React.useCallback((reason: string) => setEnded(reason || "会话已结束"), [])

  if (sq.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">载入会话…</div>
  }
  if (!s) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState icon={Eye} title="找不到这个会话" description="它可能已结束或链接有误。" />
      </div>
    )
  }
  if (!canObserve) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState icon={Eye} title="无监看权限" description="需要 session:observe 权限才能实时监看会话。" />
      </div>
    )
  }

  const km = kindMeta(s.kind)
  const isTerminal = s.kind === "interactive" || s.kind === "anonymous"
  const isGraphical = s.kind === "graphical"
  const monitorable = (isTerminal || isGraphical) && s.status === "active"

  async function terminate() {
    if (!s) return
    const ok = await confirmDialog({
      title: "强制下线该会话？",
      description: <>将立即断开 <b>{s.username}</b> 的会话，此操作记入审计。</>,
      confirmLabel: "强制下线",
      destructive: true,
    })
    if (!ok) return
    try {
      await sessionService.terminate(s.id)
      toast.success("会话已下线")
      setEnded("管理员已强制下线")
    } catch (e) {
      toast.error((e as { message?: string }).message || "下线失败")
    }
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-neutral-950 text-neutral-100">
      {/* Control bar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <Link
          href={`/sessions/${s.id}`}
          className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-100"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 详情
        </Link>
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Radio className="h-4 w-4 text-primary" />
          实时监看
        </span>
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="text-xs text-neutral-400">只读</span>

        <div className="mx-2 h-4 w-px bg-white/10" />
        <span className="truncate text-sm">{s.node_name || "目标"}</span>
        <Badge variant="soft">{km.label}</Badge>
        <span className="text-xs text-neutral-400">{s.username}</span>
        {s.client_ip && <span className="font-mono text-xs text-neutral-500">{s.client_ip}</span>}

        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-400">
          <span className="tabular-nums">{fmtDuration(s.started_at, null)}</span>
          {latency != null && <span className="tabular-nums">RTT {latency}ms</span>}
          {canTerminate && (
            <Button variant="destructive" size="sm" onClick={terminate}>
              <Power className="h-4 w-4" /> 强制下线
            </Button>
          )}
        </div>
      </div>

      {/* Stage */}
      <div className="relative min-h-0 flex-1">
        {ended ? (
          <div className="grid h-full place-items-center">
            <EmptyState icon={Eye} title="监看已结束" description={ended} />
          </div>
        ) : !monitorable ? (
          <div className="grid h-full place-items-center">
            <EmptyState
              icon={Eye}
              title="该会话无法监看"
              description={
                s.status !== "active"
                  ? "会话已结束，请回到详情页查看录像回放。"
                  : "这种会话类型不支持实时画面监看。"
              }
            />
          </div>
        ) : isTerminal ? (
          <TerminalMonitor sessionId={s.id} onLatency={onLatency} onClosed={onClosed} />
        ) : (
          <DesktopMonitor sessionId={s.id} onClosed={onClosed} />
        )}
      </div>
    </div>
  )
}
