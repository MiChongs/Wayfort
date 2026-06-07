"use client"

import * as React from "react"
import { Activity, AlertTriangle, Gauge, HardDrive, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import type { PerfPressureMetric, PerfSnapshot } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { RunInTerminalButton } from "./_shared"
import { LiveKpiStrip, perfStreamURL } from "./_live"

type Props = { nodeId: number; tabId: string; active: boolean }

// PSI / util thresholds → warm tone.
function pressTone(v: number): string {
  if (v >= 40) return "text-destructive"
  if (v >= 10) return "text-warning"
  return "text-success"
}
function pressBg(v: number): string {
  if (v >= 40) return "bg-destructive"
  if (v >= 10) return "bg-warning"
  return "bg-success"
}

export function PerformanceTab({ nodeId, tabId, active }: Props) {
  // PSI / vmstat / iostat / dmesg snapshot, pushed live over SSE.
  const url = React.useMemo(() => perfStreamURL(nodeId), [nodeId])
  const { data: d, status, error } = useSseSnapshot<PerfSnapshot>(url, { enabled: active })

  if (!active) return null

  if (status === "error" && !d) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Gauge className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法采集性能数据</div>
        <div className="text-xs">{error}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-2 pb-1.5 pt-2">
        <LiveKpiStrip nodeId={nodeId} active={active} />
      </div>
      <header className="flex items-center justify-between gap-2 border-b bg-card px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-xs font-medium">性能诊断</span>
          {d && <span className="text-[10px] text-muted-foreground">load {d.load_avg.map((x) => x.toFixed(2)).join(" / ")}</span>}
        </div>
        <RunInTerminalButton tabId={tabId} command="dmesg -Tw" label="在终端 dmesg -w（实时）" />
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {!d ? (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4">
            <Loader2 className="w-3 h-3 animate-spin" /> 采样中（约 1–2 秒）…
          </div>
        ) : (
          <>
            {/* PSI pressure */}
            {d.pressure.available ? (
              <Card>
                <CardHeader className="py-2 px-3 space-y-0">
                  <CardTitle className="text-xs font-medium flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5" /> 压力停顿 (PSI)
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 space-y-2">
                  <PressureRow label="CPU" m={d.pressure.cpu_some} />
                  <PressureRow label="IO" m={d.pressure.io_some} full={d.pressure.io_full} />
                  <PressureRow label="内存" m={d.pressure.mem_some} full={d.pressure.mem_full} />
                  <div className="text-[10px] text-muted-foreground">数值=该资源在过去 10/60/300 秒内被阻塞的时间占比（some）。</div>
                </CardContent>
              </Card>
            ) : (
              <div className="text-[11px] text-muted-foreground border rounded-md p-2">
                内核不支持 PSI（需 ≥ 4.20 且开启 CONFIG_PSI）。
              </div>
            )}

            {/* vmstat */}
            {d.vmstat.available && (
              <Card>
                <CardHeader className="py-2 px-3 space-y-0">
                  <CardTitle className="text-xs font-medium">系统活动 (vmstat · 1s)</CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 pt-0 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                  <KV k="运行/阻塞" v={`${d.vmstat.procs_r} / ${d.vmstat.procs_b}`} />
                  <KV k="上下文切换" v={`${d.vmstat.context_switches}/s`} />
                  <KV k="换入/换出" v={`${d.vmstat.swap_in_kbs} / ${d.vmstat.swap_out_kbs} KB/s`} />
                  <KV k="块入/块出" v={`${d.vmstat.block_in_kbs} / ${d.vmstat.block_out_kbs} KB/s`} />
                  <KV k="中断" v={`${d.vmstat.interrupts}/s`} />
                  <KV k="CPU us/sy/id" v={`${d.vmstat.cpu_user}/${d.vmstat.cpu_system}/${d.vmstat.cpu_idle}`} />
                  <KV k="iowait" v={`${d.vmstat.cpu_iowait}%`} tone={d.vmstat.cpu_iowait >= 20 ? "text-warning" : undefined} />
                  <KV k="steal" v={`${d.vmstat.cpu_steal}%`} tone={d.vmstat.cpu_steal > 0 ? "text-destructive" : undefined} />
                </CardContent>
              </Card>
            )}

            {/* iostat */}
            {d.sysstat_available ? (
              <Card>
                <CardHeader className="py-2 px-3 space-y-0">
                  <CardTitle className="text-xs font-medium flex items-center gap-1.5">
                    <HardDrive className="w-3.5 h-3.5" /> 磁盘 I/O (iostat)
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-0 pb-1 pt-0">
                  <table className="w-full text-[11px]">
                    <thead className="text-[10px] uppercase text-muted-foreground">
                      <tr>
                        <th className="text-left px-3 py-1">设备</th>
                        <th className="text-right px-2 py-1">tps</th>
                        <th className="text-right px-2 py-1">读 KB/s</th>
                        <th className="text-right px-2 py-1">写 KB/s</th>
                        <th className="text-right px-2 py-1">await</th>
                        <th className="text-right px-3 py-1">繁忙</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {d.disks.map((dk) => (
                        <tr key={dk.device} className="hover:bg-muted/50">
                          <td className="px-3 py-1 font-mono truncate max-w-[6rem]">{dk.device}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{dk.tps.toFixed(1)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{dk.read_kbs.toFixed(0)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{dk.write_kbs.toFixed(0)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{dk.await_ms.toFixed(1)}</td>
                          <td className={cn("px-3 py-1 text-right tabular-nums", pressTone(dk.util_pct))}>{dk.util_pct.toFixed(0)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ) : (
              <div className="text-[11px] text-muted-foreground border rounded-md p-2 flex items-center justify-between gap-2">
                <span>{d.notes || "未安装 sysstat（iostat）。"}</span>
                <RunInTerminalButton tabId={tabId} command="sudo apt-get install -y sysstat || sudo yum install -y sysstat" label="在终端安装 sysstat" size="sm" />
              </div>
            )}

            {/* dmesg / OOM */}
            <Card>
              <CardHeader className="py-2 px-3 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-xs font-medium flex items-center gap-1.5">
                  内核日志
                  {(d.oom_events?.length ?? 0) > 0 && (
                    <Badge variant="destructive" className="text-[10px]">{d.oom_events!.length} OOM</Badge>
                  )}
                </CardTitle>
                <RunInTerminalButton tabId={tabId} command="dmesg -T | tail -50" label="在终端 dmesg" />
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 space-y-2">
                {(d.oom_events?.length ?? 0) > 0 && (
                  <div className="space-y-0.5">
                    {d.oom_events!.map((l, i) => (
                      <div key={i} className="flex items-start gap-1.5 text-[10px] text-destructive font-mono">
                        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                        <span className="break-all">{l}</span>
                      </div>
                    ))}
                  </div>
                )}
                <pre className="bg-muted/60 rounded-md p-2 text-[10px] font-mono whitespace-pre-wrap break-words leading-5 max-h-56 overflow-auto">
                  {(d.dmesg_tail ?? []).join("\n") || "（无 dmesg 输出，或当前用户无权读取内核环形缓冲）"}
                </pre>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

function PressureRow({ label, m, full }: { label: string; m: PerfPressureMetric; full?: PerfPressureMetric }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("tabular-nums", pressTone(m.avg10))}>
          {m.avg10.toFixed(1)}% <span className="text-muted-foreground">· 60s {m.avg60.toFixed(1)} · 300s {m.avg300.toFixed(1)}</span>
          {full && full.avg10 > 0 && <span className="text-destructive"> · full {full.avg10.toFixed(1)}</span>}
        </span>
      </div>
      <Progress value={Math.min(100, m.avg10)} className="h-1" indicatorClassName={pressBg(m.avg10)} />
    </div>
  )
}

function KV({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn("tabular-nums font-mono", tone)}>{v}</span>
    </div>
  )
}
