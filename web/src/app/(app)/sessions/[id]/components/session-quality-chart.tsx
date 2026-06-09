"use client"

import * as React from "react"
import { Group } from "@visx/group"
import { Area, AreaClosed, LinePath, Line } from "@visx/shape"
import { scaleTime, scaleLinear } from "@visx/scale"
import { AxisBottom, AxisLeft } from "@visx/axis"
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

// Layout — two stacked panels sharing one time axis: a mirrored throughput
// stream (↑ upload above the centre line, ↓ download below) and a latency panel
// with a server-RTT line wrapped in a jitter band.
const MARGIN = { top: 10, right: 16, bottom: 22, left: 54 }
const TH_H = 92 // throughput panel height
const GAP = 34 // space + labels between panels
const LAT_H = 92 // latency panel height
const SAMPLE_SECONDS = 5

type Pt = {
  t: number
  up: number // bytes/s client→gateway
  down: number // bytes/s gateway→client
  serverRtt: number
  clientRtt: number
  jitter: number
  reconnect: boolean
}

const bisectT = bisector<Pt, number>((d) => d.t).center

export function SessionQualityChart({ samples }: { samples: SessionMetricSample[] }) {
  const pts: Pt[] = React.useMemo(
    () =>
      samples
        .map((s) => ({
          t: new Date(s.at).getTime(),
          up: (s.bytes_in_delta || 0) / SAMPLE_SECONDS,
          down: (s.bytes_out_delta || 0) / SAMPLE_SECONDS,
          serverRtt: s.server_rtt_ms ?? s.rtt_ms ?? 0,
          clientRtt: s.client_rtt_ms ?? 0,
          jitter: s.jitter_ms ?? 0,
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
        <div className="flex items-center justify-center rounded-md border border-dashed py-10 text-sm text-muted-foreground">
          连接质量指标采集中…（每 5 秒一个采样点，稍候即出现）
        </div>
      ) : (
        <ParentSize>
          {({ width }) => (width < 80 ? null : <Panels width={width} pts={pts} hasClient={hasClient} />)}
        </ParentSize>
      )}
    </div>
  )
}

function Panels({ width, pts, hasClient }: { width: number; pts: Pt[]; hasClient: boolean }) {
  const { tooltipData, tooltipLeft, showTooltip, hideTooltip } = useTooltip<Pt>()

  const innerW = width - MARGIN.left - MARGIN.right
  const innerH = TH_H + GAP + LAT_H
  const height = innerH + MARGIN.top + MARGIN.bottom

  const xs = scaleTime({
    domain: [new Date(pts[0].t), new Date(pts[pts.length - 1].t)],
    range: [0, innerW],
  })

  // ---- throughput (diverging, magnitude scale shared by both directions) ----
  const maxUp = Math.max(1, ...pts.map((p) => p.up))
  const maxDown = Math.max(1, ...pts.map((p) => p.down))
  const thCenter = TH_H / 2
  const yUp = scaleLinear({ domain: [0, maxUp], range: [thCenter, 0] })
  const yDown = scaleLinear({ domain: [0, maxDown], range: [thCenter, TH_H] })

  // ---- latency ----
  const latTop = TH_H + GAP
  const maxRtt = Math.max(5, ...pts.map((p) => Math.max(p.serverRtt + p.jitter, p.clientRtt)))
  const yRtt = scaleLinear({ domain: [0, maxRtt * 1.15], range: [LAT_H, 0], nice: true })

  function handleMove(e: React.MouseEvent | React.TouchEvent) {
    const pt = localPoint(e)
    if (!pt) return
    const t = xs.invert(pt.x - MARGIN.left).getTime()
    const d = pts[bisectT(pts, t)]
    if (!d) return
    showTooltip({ tooltipData: d, tooltipLeft: MARGIN.left + xs(new Date(d.t)) })
  }

  return (
    <div className="relative">
      <svg width={width} height={height} onMouseMove={handleMove} onMouseLeave={hideTooltip}>
        <LinearGradient id="q-up" from={VIZ.coral} to={VIZ.coral} fromOpacity={0.5} toOpacity={0.05} />
        <LinearGradient id="q-down" from={VIZ.amber} to={VIZ.amber} fromOpacity={0.05} toOpacity={0.5} />
        <LinearGradient id="q-lat" from={VIZ.teal} to={VIZ.teal} fromOpacity={0.28} toOpacity={0.03} />

        <Group left={MARGIN.left} top={MARGIN.top}>
          {/* ===== throughput panel ===== */}
          <Group top={0}>
            <text x={0} y={-1} fontSize={10} fill={VIZ.coral} fontWeight={500}>
              ↑ 上行
            </text>
            <text x={0} y={TH_H + 9} fontSize={10} fill={VIZ.amber} fontWeight={500}>
              ↓ 下行
            </text>
            <text x={innerW} y={-1} fontSize={9} fill={VIZ.tick} textAnchor="end">
              峰值 {fmtBytes(maxUp)}/s
            </text>
            <text x={innerW} y={TH_H + 9} fontSize={9} fill={VIZ.tick} textAnchor="end">
              峰值 {fmtBytes(maxDown)}/s
            </text>
            <AreaClosed
              data={pts}
              x={(d) => xs(new Date(d.t))}
              y={(d) => yUp(d.up)}
              yScale={yUp}
              curve={curveMonotoneX}
              fill="url(#q-up)"
            />
            <LinePath data={pts} x={(d) => xs(new Date(d.t))} y={(d) => yUp(d.up)} stroke={VIZ.coral} strokeWidth={1.5} curve={curveMonotoneX} />
            <AreaClosed
              data={pts}
              x={(d) => xs(new Date(d.t))}
              y={(d) => yDown(d.down)}
              yScale={yDown}
              curve={curveMonotoneX}
              fill="url(#q-down)"
            />
            <LinePath data={pts} x={(d) => xs(new Date(d.t))} y={(d) => yDown(d.down)} stroke={VIZ.amber} strokeWidth={1.5} curve={curveMonotoneX} />
            <Line from={{ x: 0, y: thCenter }} to={{ x: innerW, y: thCenter }} stroke={VIZ.axis} strokeWidth={1} />
          </Group>

          {/* ===== latency panel ===== */}
          <Group top={latTop}>
            <text x={0} y={-3} fontSize={10} fill={VIZ.teal} fontWeight={500}>
              延迟
            </text>
            {/* jitter band around the server RTT */}
            <Area
              data={pts}
              x={(d) => xs(new Date(d.t))}
              y0={(d) => yRtt(Math.max(0, d.serverRtt - d.jitter))}
              y1={(d) => yRtt(d.serverRtt + d.jitter)}
              curve={curveMonotoneX}
              fill="url(#q-lat)"
            />
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
            <LinePath data={pts} x={(d) => xs(new Date(d.t))} y={(d) => yRtt(d.serverRtt)} stroke={VIZ.teal} strokeWidth={1.75} curve={curveMonotoneX} />
            <AxisLeft
              scale={yRtt}
              numTicks={3}
              tickFormat={(v) => `${Number(v)}ms`}
              stroke={VIZ.axis}
              tickStroke={VIZ.axis}
              tickLabelProps={() => ({ fill: VIZ.tick, fontSize: 9, textAnchor: "end", dx: -2, dy: 3 })}
            />
          </Group>

          {/* ===== reconnect markers + crosshair span both panels ===== */}
          {pts.map((d, i) =>
            d.reconnect ? (
              <Group key={i}>
                <Line from={{ x: xs(new Date(d.t)), y: 0 }} to={{ x: xs(new Date(d.t)), y: innerH }} stroke={VIZ.danger} strokeWidth={1} strokeDasharray="2 3" opacity={0.55} />
                <AbnormalDot cx={xs(new Date(d.t))} cy={4} />
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
        <VizTooltip top={MARGIN.top} left={(tooltipLeft ?? 0) + 8}>
          <div className="text-muted-foreground">{fullTime(new Date(tooltipData.t).toISOString())}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span style={{ color: VIZ.coral }}>↑</span> {fmtBytes(tooltipData.up)}/s
            <span className="ml-2" style={{ color: VIZ.amber }}>↓</span> {fmtBytes(tooltipData.down)}/s
          </div>
          <div className="mt-0.5">服务端 RTT {tooltipData.serverRtt || "<1"} ms</div>
          {hasClient && <div>客户端 RTT {tooltipData.clientRtt || "<1"} ms</div>}
          {tooltipData.jitter > 0 && <div>抖动 ±{tooltipData.jitter} ms</div>}
          {tooltipData.reconnect && <div className="text-destructive">发生重连</div>}
        </VizTooltip>
      )}
    </div>
  )
}

function Legend({ hasClient }: { hasClient: boolean }) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span className="h-2 w-3 rounded-sm" style={{ background: VIZ.coral }} /> 上行
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="h-2 w-3 rounded-sm" style={{ background: VIZ.amber }} /> 下行
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
