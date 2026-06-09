"use client"

import * as React from "react"
import { Group } from "@visx/group"
import { LinePath, AreaClosed, Line } from "@visx/shape"
import { scaleTime, scaleLinear } from "@visx/scale"
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis"
import { GridRows } from "@visx/grid"
import { LinearGradient } from "@visx/gradient"
import { curveMonotoneX } from "@visx/curve"
import { ParentSize } from "@visx/responsive"
import { localPoint } from "@visx/event"
import { bisector } from "d3-array"
import { Gauge } from "lucide-react"
import type { SessionMetricSample } from "@/lib/api/types"
import { fmtBytes, fullTime } from "@/lib/format"
import { VIZ } from "@/lib/viz/theme"
import { AbnormalDot } from "@/lib/viz/dots"
import { VizTooltip, useTooltip } from "@/lib/viz/tooltip"

const HEIGHT = 220
const MARGIN = { top: 12, right: 52, bottom: 26, left: 56 }
// Samples are written on a fixed ≈5s cadence; turn the per-window byte delta
// into a bytes/second throughput for the bandwidth series.
const SAMPLE_SECONDS = 5

type Pt = {
  t: number
  serverRtt: number
  clientRtt: number
  jitter: number
  bps: number
  reconnect: boolean
}

const bisectT = bisector<Pt, number>((d) => d.t).center

export function SessionQualityChart({ samples }: { samples: SessionMetricSample[] }) {
  const pts: Pt[] = React.useMemo(
    () =>
      samples
        .map((s) => ({
          t: new Date(s.at).getTime(),
          // server RTT falls back to the primary rtt_ms when the split fields
          // aren't present (older rows); client is its own field.
          serverRtt: s.server_rtt_ms ?? s.rtt_ms ?? 0,
          clientRtt: s.client_rtt_ms ?? 0,
          jitter: s.jitter_ms ?? 0,
          bps: ((s.bytes_in_delta || 0) + (s.bytes_out_delta || 0)) / SAMPLE_SECONDS,
          reconnect: (s.reconnects || 0) > 0,
        }))
        .sort((a, b) => a.t - b.t),
    [samples],
  )
  const hasClient = pts.some((p) => p.clientRtt > 0)

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Gauge className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">连接质量</span>
        <Legend hasClient={hasClient} />
      </div>
      {pts.length < 2 ? (
        <div className="flex items-center justify-center rounded-md border border-dashed py-8 text-sm text-muted-foreground">
          连接质量指标采集中…（每 5 秒一个采样点，稍候即出现）
        </div>
      ) : (
        <ParentSize>
          {({ width }) => (width < 60 ? null : <Chart width={width} pts={pts} hasClient={hasClient} />)}
        </ParentSize>
      )}
    </div>
  )
}

function Chart({ width, pts, hasClient }: { width: number; pts: Pt[]; hasClient: boolean }) {
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<Pt>()

  const innerW = width - MARGIN.left - MARGIN.right
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom

  const xs = scaleTime({
    domain: [new Date(pts[0].t), new Date(pts[pts.length - 1].t)],
    range: [0, innerW],
  })
  const maxBps = Math.max(1, ...pts.map((p) => p.bps))
  const yBps = scaleLinear({ domain: [0, maxBps * 1.15], range: [innerH, 0], nice: true })
  const maxRtt = Math.max(5, ...pts.map((p) => Math.max(p.serverRtt, p.clientRtt)))
  const yRtt = scaleLinear({ domain: [0, maxRtt * 1.2], range: [innerH, 0], nice: true })

  function handleMove(e: React.MouseEvent | React.TouchEvent) {
    const pt = localPoint(e)
    if (!pt) return
    const t = xs.invert(pt.x - MARGIN.left).getTime()
    const d = pts[bisectT(pts, t)]
    if (!d) return
    showTooltip({
      tooltipData: d,
      tooltipLeft: MARGIN.left + xs(new Date(d.t)),
      tooltipTop: MARGIN.top + yBps(d.bps),
    })
  }

  return (
    <div className="relative">
      <svg width={width} height={HEIGHT} onMouseMove={handleMove} onMouseLeave={hideTooltip}>
        <LinearGradient id="bw-grad" from={VIZ.coral} to={VIZ.coral} fromOpacity={0.3} toOpacity={0.02} />
        <Group left={MARGIN.left} top={MARGIN.top}>
          <GridRows scale={yBps} width={innerW} height={innerH} stroke={VIZ.grid} strokeOpacity={0.5} numTicks={4} />
          {/* Bandwidth — primary, always-present series */}
          <AreaClosed
            data={pts}
            x={(d) => xs(new Date(d.t))}
            y={(d) => yBps(d.bps)}
            yScale={yBps}
            curve={curveMonotoneX}
            fill="url(#bw-grad)"
          />
          <LinePath
            data={pts}
            x={(d) => xs(new Date(d.t))}
            y={(d) => yBps(d.bps)}
            stroke={VIZ.coral}
            strokeWidth={1.75}
            curve={curveMonotoneX}
          />
          {/* Client RTT (browser↔gateway) — secondary, faint dashed */}
          {hasClient && (
            <LinePath
              data={pts}
              x={(d) => xs(new Date(d.t))}
              y={(d) => yRtt(d.clientRtt)}
              stroke={VIZ.neutral}
              strokeWidth={1.25}
              strokeDasharray="3 3"
              curve={curveMonotoneX}
            />
          )}
          {/* Server RTT (gateway↔target) — the meaningful session latency */}
          <LinePath
            data={pts}
            x={(d) => xs(new Date(d.t))}
            y={(d) => yRtt(d.serverRtt)}
            stroke={VIZ.teal}
            strokeWidth={1.5}
            curve={curveMonotoneX}
          />
          {/* Reconnect markers */}
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
            scale={yBps}
            numTicks={4}
            tickFormat={(v) => fmtBytes(Number(v)) + "/s"}
            stroke={VIZ.axis}
            tickStroke={VIZ.axis}
            tickLabelProps={() => ({ fill: VIZ.tick, fontSize: 9, textAnchor: "end", dx: -2, dy: 3 })}
          />
          <AxisRight
            left={innerW}
            scale={yRtt}
            numTicks={4}
            tickFormat={(v) => `${Number(v)}ms`}
            stroke={VIZ.axis}
            tickStroke={VIZ.axis}
            tickLabelProps={() => ({ fill: VIZ.teal, fontSize: 9, textAnchor: "start", dx: 2, dy: 3 })}
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
          <div className="mt-0.5">吞吐 {fmtBytes(tooltipData.bps)}/s</div>
          <div>服务端 RTT {tooltipData.serverRtt || "<1"} ms</div>
          {hasClient && <div>客户端 RTT {tooltipData.clientRtt || "<1"} ms</div>}
          {tooltipData.jitter > 0 && <div>抖动 {tooltipData.jitter} ms</div>}
          {tooltipData.reconnect && <div className="text-destructive">发生重连</div>}
        </VizTooltip>
      )}
    </div>
  )
}

function Legend({ hasClient }: { hasClient: boolean }) {
  return (
    <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span className="h-2 w-3 rounded-sm" style={{ background: VIZ.coral }} /> 吞吐
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="h-0.5 w-3" style={{ background: VIZ.teal }} /> 服务端 RTT
      </span>
      {hasClient && (
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3 border-t border-dashed" style={{ borderColor: VIZ.neutral }} /> 客户端 RTT
        </span>
      )}
    </div>
  )
}
