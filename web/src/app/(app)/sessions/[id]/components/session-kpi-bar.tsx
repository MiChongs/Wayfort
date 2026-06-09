"use client"

import * as React from "react"
import { Activity, Gauge, RefreshCw, Timer, Film } from "lucide-react"
import type { Session, SessionMetricSample } from "@/lib/api/types"
import { fmtBytes } from "@/lib/format"
import { fmtDuration } from "@/lib/session-meta"
import { cn } from "@/lib/utils"

// SessionKpiBar is the headline strip of the lifecycle dashboard: duration,
// throughput, reconnects, peak latency, and recording status. Values degrade to
// "—" when the backend hasn't recorded them (graphical/forward sessions, or
// rows that predate lifecycle-v3), so the bar always renders.
export function SessionKpiBar({
  session,
  samples,
}: {
  session: Session
  samples: SessionMetricSample[]
}) {
  const isActive = session.status === "active"

  const peakRtt =
    session.peak_rtt_ms ||
    samples.reduce((m, s) => Math.max(m, s.rtt_ms || 0), 0)
  const reconnects =
    session.reconnect_count ??
    samples.reduce((n, s) => n + (s.reconnects || 0), 0)

  const recLabel =
    session.recording_type === "asciicast"
      ? "终端回放"
      : session.recording_type === "desktop"
        ? "桌面录像"
        : session.recording_type === "guac"
          ? "仅下载"
          : "无录像"

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Kpi
        icon={Timer}
        label="时长"
        value={fmtDuration(session.started_at, isActive ? null : session.ended_at)}
        live={isActive}
      />
      <Kpi
        icon={Gauge}
        label="流量"
        value={`↑${fmtBytes(session.bytes_in)} ↓${fmtBytes(session.bytes_out)}`}
      />
      <Kpi
        icon={RefreshCw}
        label="重连"
        value={reconnects > 0 ? `${reconnects} 次` : "0"}
        tone={reconnects > 0 ? "amber" : undefined}
      />
      <Kpi
        icon={Activity}
        label="峰值延迟"
        value={peakRtt > 0 ? `${peakRtt} ms` : "—"}
      />
      <Kpi icon={Film} label="录像" value={recLabel} />
    </div>
  )
}

function Kpi({
  icon: Icon,
  label,
  value,
  live,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  live?: boolean
  tone?: "amber"
}) {
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
            tone === "amber"
              ? "bg-chart-3/15 text-chart-3"
              : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {label}
            {live && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
            )}
          </div>
          <div className="truncate text-lg font-semibold tabular-nums">{value}</div>
        </div>
      </div>
    </div>
  )
}
