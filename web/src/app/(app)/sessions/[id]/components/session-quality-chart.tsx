"use client"

import * as React from "react"
import { Group } from "@visx/group"
import { LinePath, AreaClosed, Line } from "@visx/shape"
import { scaleTime, scaleLinear } from "@visx/scale"
import { AxisBottom, AxisLeft } from "@visx/axis"
import { GridRows } from "@visx/grid"
import { LinearGradient } from "@visx/gradient"
import { curveMonotoneX } from "@visx/curve"
import { ParentSize } from "@visx/responsive"
import { localPoint } from "@visx/event"
import { Gauge } from "lucide-react"
import type { SessionMetricSample } from "@/lib/api/types"
import { fullTime } from "@/lib/format"
import { VIZ } from "@/lib/viz/theme"
import { AbnormalDot } from "@/lib/viz/dots"
import { VizTooltip, useTooltip } from "@/lib/viz/tooltip"

const HEIGHT = 220
const MARGIN = { top: 12, right: 44, bottom: 26, left: 40 }

type Pt = { t: number; rtt: number; loss: number; reconnect: boolean }

// nearestIndex returns the index of the sample closest to time t (binary search
// over the ascending-by-t points), avoiding a d3-array dependency.
function nearestIndex(pts: Pt[], t: number): number {
  let lo = 0
  let hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid].t < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(pts[lo - 1].t - t) <= Math.abs(pts[lo].t - t)) return lo - 1
  return lo
}

export function SessionQualityChart({ samples }: { samples: SessionMetricSample[] }) {
  const pts: Pt[] = React.useMemo(
    () =>
      samples
        .map((s) => ({
          t: new Date(s.at).getTime(),
          rtt: s.rtt_ms || 0,
          loss: (s.loss_pct || 0) / 100,
          reconnect: (s.reconnects || 0) > 0,
        }))
        .sort((a, b) => a.t - b.t),
    [samples],
  )

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Gauge className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">连接质量</span>
        <Legend />
      </div>
      {pts.length < 2 ? (
        <div className="flex items-center justify-center rounded-md border border-dashed py-8 text-sm text-muted-foreground">
          本次会话未采集连接质量指标
        </div>
      ) : (
        <ParentSize>
          {({ width }) => (width < 60 ? null : <Chart width={width} pts={pts} />)}
        </ParentSize>
      )}
    </div>
  )
}

function Chart({ width, pts }: { width: number; pts: Pt[] }) {
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<Pt>()

  const innerW = width - MARGIN.left - MARGIN.right
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom

  const xs = scaleTime({
    domain: [new Date(pts[0].t), new Date(pts[pts.length - 1].t)],
    range: [0, innerW],
  })
  const maxRtt = Math.max(10, ...pts.map((p) => p.rtt))
  const ys = scaleLinear({ domain: [0, maxRtt * 1.15], range: [innerH, 0], nice: true })
  const maxLoss = Math.max(1, ...pts.map((p) => p.loss))
  const yLoss = scaleLinear({ domain: [0, maxLoss * 1.2], range: [innerH, 0], nice: true })

  function handleMove(e: React.MouseEvent | React.TouchEvent) {
    const pt = localPoint(e)
    if (!pt) return
    const t = xs.invert(pt.x - MARGIN.left).getTime()
    const d = pts[nearestIndex(pts, t)]
    showTooltip({
      tooltipData: d,
      tooltipLeft: MARGIN.left + xs(new Date(d.t)),
      tooltipTop: MARGIN.top + ys(d.rtt),
    })
  }

  return (
    <div className="relative">
      <svg width={width} height={HEIGHT} onMouseMove={handleMove} onMouseLeave={hideTooltip}>
        <LinearGradient id="rtt-grad" from={VIZ.teal} to={VIZ.teal} fromOpacity={0.32} toOpacity={0.02} />
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows scale={ys} width={innerW} height={innerH} stroke={VIZ.grid} strokeOpacity={0.5} numTicks={4} />
          <AreaClosed
            data={pts}
            x={(d) => xs(new Date(d.t))}
            y={(d) => ys(d.rtt)}
            yScale={ys}
            curve={curveMonotoneX}
            fill="url(#rtt-grad)"
          />
          <LinePath
            data={pts}
            x={(d) => xs(new Date(d.t))}
            y={(d) => ys(d.rtt)}
            stroke={VIZ.teal}
            strokeWidth={1.75}
            curve={curveMonotoneX}
          />
          {maxLoss > 0 && (
            <LinePath
              data={pts}
              x={(d) => xs(new Date(d.t))}
              y={(d) => yLoss(d.loss)}
              stroke={VIZ.amber}
              strokeWidth={1.5}
              strokeDasharray="3 3"
              curve={curveMonotoneX}
            />
          )}
          {pts.map((d, i) =>
            d.reconnect ? (
              <Group key={i}>
                <Line
                  from={{ x: xs(new Date(d.t)), y: 0 }}
                  to={{ x: xs(new Date(d.t)), y: innerH }}
                  stroke={VIZ.danger}
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  opacity={0.6}
                />
                <AbnormalDot cx={xs(new Date(d.t))} cy={6} />
              </Group>
            ) : null,
          )}
          {tooltipData && (
            <Line
              from={{ x: xs(new Date(tooltipData.t)), y: 0 }}
              to={{ x: xs(new Date(tooltipData.t)), y: innerH }}
              stroke={VIZ.tick}
              strokeWidth={1}
              strokeDasharray="2 2"
              opacity={0.5}
            />
          )}
          <AxisLeft
            scale={ys}
            numTicks={4}
            stroke={VIZ.axis}
            tickStroke={VIZ.axis}
            tickLabelProps={() => ({ fill: VIZ.tick, fontSize: 10, textAnchor: "end", dx: -2, dy: 3 })}
          />
          <AxisBottom
            top={innerH}
            scale={xs}
            numTicks={Math.min(6, Math.floor(innerW / 90))}
            stroke={VIZ.axis}
            tickStroke={VIZ.axis}
            tickLabelProps={() => ({ fill: VIZ.tick, fontSize: 10, textAnchor: "middle" })}
          />
        </Group>
      </svg>
      {tooltipData && (
        <VizTooltip top={(tooltipTop ?? 0) + 8} left={(tooltipLeft ?? 0) + 8}>
          <div className="text-muted-foreground">{fullTime(new Date(tooltipData.t).toISOString())}</div>
          <div className="mt-0.5">RTT {tooltipData.rtt} ms</div>
          {tooltipData.loss > 0 && <div>丢包 {tooltipData.loss.toFixed(2)}%</div>}
          {tooltipData.reconnect && <div className="text-destructive">发生重连</div>}
        </VizTooltip>
      )}
    </div>
  )
}

function Legend() {
  return (
    <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span className="h-2 w-3 rounded-sm" style={{ background: VIZ.teal }} /> RTT
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="h-0.5 w-3" style={{ background: VIZ.amber }} /> 丢包
      </span>
    </div>
  )
}
