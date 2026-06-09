"use client"

import * as React from "react"
import { Group } from "@visx/group"
import { Bar, Line } from "@visx/shape"
import { scaleTime } from "@visx/scale"
import { AxisBottom } from "@visx/axis"
import { ParentSize } from "@visx/responsive"
import { localPoint } from "@visx/event"
import { Activity } from "lucide-react"
import type { SessionPhase } from "@/lib/api/types"
import { phaseMeta, fmtDuration } from "@/lib/session-meta"
import { fullTime } from "@/lib/format"
import { PHASE_FILL, VIZ } from "@/lib/viz/theme"
import { AbnormalDot } from "@/lib/viz/dots"
import { VizTooltip, useTooltip } from "@/lib/viz/tooltip"

const HEIGHT = 96
const BAR_TOP = 16
const BAR_H = 38
const MARGIN = { left: 8, right: 8, bottom: 26 }

export function SessionPhaseGantt({
  phases,
  startedAt,
  endedAt,
}: {
  phases: SessionPhase[]
  startedAt: string
  endedAt?: string | null
}) {
  if (!phases.length) {
    return (
      <Panel>
        <div className="flex items-center justify-center rounded-md border border-dashed py-8 text-sm text-muted-foreground">
          本次会话没有阶段记录（旧会话或未采集）
        </div>
      </Panel>
    )
  }
  return (
    <Panel>
      <ParentSize>
        {({ width }) =>
          width < 40 ? null : (
            <GanttSvg width={width} phases={phases} startedAt={startedAt} endedAt={endedAt} />
          )
        }
      </ParentSize>
      <Legend phases={phases} />
    </Panel>
  )
}

function GanttSvg({
  width,
  phases,
  startedAt,
  endedAt,
}: {
  width: number
  phases: SessionPhase[]
  startedAt: string
  endedAt?: string | null
}) {
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<SessionPhase>()

  const innerW = Math.max(10, width - MARGIN.left - MARGIN.right)

  const t0 = new Date(startedAt).getTime()
  const ends = phases.map((p) =>
    p.ended_at ? new Date(p.ended_at).getTime() : Date.now(),
  )
  const t1 = Math.max(
    endedAt ? new Date(endedAt).getTime() : 0,
    ...ends,
    t0 + 1000,
  )
  const x = scaleTime({ domain: [new Date(t0), new Date(t1)], range: [0, innerW] })

  return (
    <div className="relative">
      <svg width={width} height={HEIGHT}>
        <Group left={MARGIN.left}>
          {phases.map((p) => {
            const sx = x(new Date(p.started_at))
            const ex = x(new Date(p.ended_at ?? new Date(t1).toISOString()))
            const w = Math.max(3, ex - sx)
            const failed = p.status === "failed"
            return (
              <Group key={p.id}>
                <Bar
                  x={sx}
                  y={BAR_TOP}
                  width={w}
                  height={BAR_H}
                  rx={4}
                  fill={PHASE_FILL[p.phase] ?? VIZ.neutral}
                  fillOpacity={failed ? 0.55 : 0.9}
                  stroke={failed ? VIZ.danger : "transparent"}
                  strokeWidth={failed ? 1.5 : 0}
                  onMouseMove={(e) => {
                    const pt = localPoint(e) ?? { x: sx, y: BAR_TOP }
                    showTooltip({ tooltipData: p, tooltipLeft: pt.x, tooltipTop: pt.y })
                  }}
                  onMouseLeave={hideTooltip}
                  style={{ cursor: "pointer" }}
                />
                {failed && <AbnormalDot cx={sx + w - 4} cy={BAR_TOP + 4} />}
                {w > 44 && (
                  <text
                    x={sx + 6}
                    y={BAR_TOP + BAR_H / 2 + 4}
                    fontSize={11}
                    fill="var(--card)"
                    pointerEvents="none"
                  >
                    {phaseMeta(p.phase).label}
                  </text>
                )}
              </Group>
            )
          })}
          <Line
            from={{ x: 0, y: BAR_TOP + BAR_H + 6 }}
            to={{ x: innerW, y: BAR_TOP + BAR_H + 6 }}
            stroke={VIZ.grid}
            strokeWidth={1}
          />
          <AxisBottom
            top={BAR_TOP + BAR_H + 6}
            scale={x}
            numTicks={Math.min(6, Math.floor(innerW / 90))}
            stroke={VIZ.axis}
            tickStroke={VIZ.axis}
            tickLabelProps={() => ({
              fill: VIZ.tick,
              fontSize: 10,
              textAnchor: "middle",
            })}
          />
        </Group>
      </svg>
      {tooltipData && (
        <VizTooltip top={(tooltipTop ?? 0) + 12} left={(tooltipLeft ?? 0) + 12}>
          <div className="font-medium">{phaseMeta(tooltipData.phase).label}</div>
          <div className="mt-0.5 text-muted-foreground">
            {fullTime(tooltipData.started_at)} →{" "}
            {tooltipData.ended_at ? fullTime(tooltipData.ended_at) : "进行中"}
          </div>
          <div className="mt-0.5">
            耗时 {fmtDuration(tooltipData.started_at, tooltipData.ended_at ?? null)}
            {tooltipData.status === "failed" && (
              <span className="ml-1 text-destructive">· 失败</span>
            )}
          </div>
          {tooltipData.detail && (
            <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
              {tooltipData.detail}
            </div>
          )}
        </VizTooltip>
      )}
    </div>
  )
}

function Legend({ phases }: { phases: SessionPhase[] }) {
  const seen = new Set<string>()
  const items = phases.filter((p) => {
    if (seen.has(p.phase)) return false
    seen.add(p.phase)
    return true
  })
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
      {items.map((p) => (
        <span key={p.phase} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="h-2.5 w-2.5 rounded-sm"
            style={{ background: PHASE_FILL[p.phase] ?? VIZ.neutral }}
          />
          {phaseMeta(p.phase).label}
        </span>
      ))}
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">连接生命周期</span>
      </div>
      {children}
    </div>
  )
}
