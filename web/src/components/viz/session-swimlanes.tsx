"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { Group } from "@visx/group"
import { Bar, Line } from "@visx/shape"
import { scaleTime, scaleBand } from "@visx/scale"
import { AxisBottom } from "@visx/axis"
import { ParentSize } from "@visx/responsive"
import { localPoint } from "@visx/event"
import { CalendarRange, Layers } from "lucide-react"
import { sessionService } from "@/lib/api/services"
import type { Session } from "@/lib/api/types"
import { kindMeta, statusMeta, fmtDuration } from "@/lib/session-meta"
import { fullTime } from "@/lib/format"
import { KIND_FILL, VIZ } from "@/lib/viz/theme"
import { VizTooltip, useTooltip } from "@/lib/viz/tooltip"
import { cn } from "@/lib/utils"

type GroupBy = "username" | "node_name"
const WINDOWS = [
  { key: "24h", label: "近 24 小时", hours: 24 },
  { key: "7d", label: "近 7 天", hours: 24 * 7 },
  { key: "30d", label: "近 30 天", hours: 24 * 30 },
] as const

const ROW_H = 26
const MARGIN = { top: 6, right: 12, bottom: 24, left: 130 }
const MAX_LANES = 60 // guard against an unbounded SVG; overflow is surfaced

// SessionSwimlanes plots every session in a time window as a horizontal bar on a
// per-user (or per-asset) lane, so overlapping/concurrent sessions and busy
// assets are visible at a glance. Time window + grouping are user-controlled to
// bound the data; the live "now" edge is marked, and clicking a bar opens the
// session detail.
export function SessionSwimlanes() {
  const router = useRouter()
  const [winKey, setWinKey] = React.useState<(typeof WINDOWS)[number]["key"]>("24h")
  const [groupBy, setGroupBy] = React.useState<GroupBy>("username")

  const win = WINDOWS.find((w) => w.key === winKey)!
  // from is recomputed each render but only feeds the query key at hour
  // granularity via winKey, so it doesn't thrash. Stable enough for a viewer.
  const fromISO = React.useMemo(
    () => new Date(Date.now() - win.hours * 3600_000).toISOString(),
    [win.hours],
  )

  const q = useQuery({
    queryKey: ["sessions", "swimlanes", winKey],
    queryFn: () => sessionService.list({ from: fromISO, limit: 500 }),
    refetchInterval: 15_000,
  })
  const sessions = q.data?.sessions ?? []

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Layers className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">会话泳道</span>
        <span className="text-xs text-muted-foreground">{sessions.length} 个会话</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Seg
            value={groupBy}
            onChange={(v) => setGroupBy(v as GroupBy)}
            options={[
              { key: "username", label: "按用户" },
              { key: "node_name", label: "按资产" },
            ]}
          />
          <div className="mx-1 h-4 w-px bg-border" />
          <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
          <Seg
            value={winKey}
            onChange={(v) => setWinKey(v as typeof winKey)}
            options={WINDOWS.map((w) => ({ key: w.key, label: w.label }))}
          />
        </div>
      </div>
      <div className="p-4">
        {sessions.length === 0 ? (
          <div className="flex items-center justify-center rounded-md border border-dashed py-10 text-sm text-muted-foreground">
            {q.isLoading ? "载入会话…" : "该时间窗内没有会话"}
          </div>
        ) : (
          <ParentSize>
            {({ width }) =>
              width < 80 ? null : (
                <Lanes
                  width={width}
                  sessions={sessions}
                  groupBy={groupBy}
                  fromMs={new Date(fromISO).getTime()}
                  onPick={(id) => router.push(`/sessions/${id}` as Parameters<typeof router.push>[0])}
                />
              )
            }
          </ParentSize>
        )}
      </div>
    </div>
  )
}

function Lanes({
  width,
  sessions,
  groupBy,
  fromMs,
  onPick,
}: {
  width: number
  sessions: Session[]
  groupBy: GroupBy
  fromMs: number
  onPick: (id: string) => void
}) {
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } = useTooltip<Session>()

  const nowMs = Date.now()
  const innerW = width - MARGIN.left - MARGIN.right

  // Build lanes (group keys), most-active first, capped.
  const { lanes, overflow } = React.useMemo(() => {
    const byKey = new Map<string, number>()
    for (const s of sessions) {
      const k = (groupBy === "username" ? s.username : s.node_name) || "—"
      byKey.set(k, (byKey.get(k) ?? 0) + 1)
    }
    const sorted = [...byKey.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    return { lanes: sorted.slice(0, MAX_LANES), overflow: Math.max(0, sorted.length - MAX_LANES) }
  }, [sessions, groupBy])

  const x = scaleTime({ domain: [new Date(fromMs), new Date(nowMs)], range: [0, innerW] })
  const y = scaleBand({ domain: lanes, range: [0, lanes.length * ROW_H], padding: 0.25 })
  const innerH = lanes.length * ROW_H
  const laneSet = new Set(lanes)

  return (
    <div className="relative">
      <div className="overflow-y-auto" style={{ maxHeight: 460 }}>
        <svg width={width} height={innerH + MARGIN.top + MARGIN.bottom}>
          <Group left={MARGIN.left} top={MARGIN.top}>
            {/* lane labels + separators */}
            {lanes.map((k) => {
              const ly = y(k) ?? 0
              return (
                <Group key={k}>
                  <text
                    x={-8}
                    y={ly + y.bandwidth() / 2 + 4}
                    textAnchor="end"
                    fontSize={11}
                    fill={VIZ.tick}
                  >
                    {truncate(k, 16)}
                  </text>
                  <Line from={{ x: 0, y: ly + y.bandwidth() + 3 }} to={{ x: innerW, y: ly + y.bandwidth() + 3 }} stroke={VIZ.grid} strokeOpacity={0.4} />
                </Group>
              )
            })}

            {/* session bars */}
            {sessions.map((s) => {
              const k = (groupBy === "username" ? s.username : s.node_name) || "—"
              if (!laneSet.has(k)) return null
              const startMs = Math.max(fromMs, new Date(s.started_at).getTime())
              const endMs = s.ended_at ? new Date(s.ended_at).getTime() : nowMs
              const bx = x(new Date(startMs))
              const bw = Math.max(2, x(new Date(Math.max(endMs, startMs))) - bx)
              const ly = y(k) ?? 0
              const active = s.status === "active"
              const errored = s.status === "errored"
              return (
                <Bar
                  key={s.id}
                  x={bx}
                  y={ly}
                  width={bw}
                  height={y.bandwidth()}
                  rx={3}
                  fill={KIND_FILL[s.kind] ?? VIZ.neutral}
                  fillOpacity={active ? 0.95 : 0.7}
                  stroke={errored ? VIZ.danger : "transparent"}
                  strokeWidth={errored ? 1.25 : 0}
                  style={{ cursor: "pointer" }}
                  onMouseMove={(e) => {
                    const pt = localPoint(e) ?? { x: bx, y: ly }
                    showTooltip({ tooltipData: s, tooltipLeft: pt.x, tooltipTop: pt.y })
                  }}
                  onMouseLeave={hideTooltip}
                  onClick={() => onPick(s.id)}
                />
              )
            })}

            {/* now line */}
            <Line from={{ x: innerW, y: 0 }} to={{ x: innerW, y: innerH }} stroke={VIZ.coral} strokeWidth={1} strokeDasharray="3 3" />

            <AxisBottom
              top={innerH}
              scale={x}
              numTicks={Math.min(7, Math.floor(innerW / 110))}
              stroke={VIZ.axis}
              tickStroke={VIZ.axis}
              tickLabelProps={() => ({ fill: VIZ.tick, fontSize: 10, textAnchor: "middle" })}
            />
          </Group>
        </svg>
      </div>
      {overflow > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          仅显示最活跃的 {MAX_LANES} 条泳道，另有 {overflow} 条已折叠（缩小时间窗或换分组查看）。
        </div>
      )}
      {tooltipData && (
        <VizTooltip top={(tooltipTop ?? 0) + 16} left={(tooltipLeft ?? 0) + MARGIN.left}>
          <div className="font-medium">{tooltipData.node_name || "匿名目标"}</div>
          <div className="mt-0.5 text-muted-foreground">
            {kindMeta(tooltipData.kind).label} · {statusMeta(tooltipData.status).label} · {tooltipData.username}
          </div>
          <div className="mt-0.5">
            {fullTime(tooltipData.started_at)} · 时长 {fmtDuration(tooltipData.started_at, tooltipData.ended_at ?? null)}
          </div>
        </VizTooltip>
      )}
    </div>
  )
}

function Seg({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { key: string; label: string }[]
}) {
  return (
    <div className="inline-flex rounded-md border bg-muted/30 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={cn(
            "rounded px-2 py-0.5 text-xs transition-colors",
            value === o.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}
