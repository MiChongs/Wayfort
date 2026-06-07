"use client"

import * as React from "react"
import { Activity, HardDrive } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import type { SystemSnapshot } from "@/lib/api/services"
import { formatBps, formatBytes, usagePctBg, usagePctTone } from "./format"

export interface DisksTabProps {
  system?: SystemSnapshot
}

export function DisksTab({ system }: DisksTabProps) {
  if (!system) {
    return <div className="p-4 text-sm text-muted-foreground">采集中…</div>
  }
  const disks = system.disks.slice().sort((a, b) => b.used_pct - a.used_pct)
  const io = system.disk_io ?? []
  if (disks.length === 0 && io.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">无挂载点信息</div>
  }
  return (
    <div className="p-3 space-y-3">
      <section className="space-y-2">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-0.5">
          容量
        </h3>
        {disks.map((d) => (
          <Card key={d.mount}>
            <CardContent className="px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  <HardDrive className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="font-mono truncate" title={d.mount}>
                    {d.mount}
                  </span>
                  {d.source && (
                    <span className="text-[10px] text-muted-foreground font-mono truncate">
                      ({d.source})
                    </span>
                  )}
                </div>
                <span className={"tabular-nums font-medium " + usagePctTone(d.used_pct)}>
                  {d.used_pct}%
                </span>
              </div>
              <Progress
                value={Math.min(100, d.used_pct)}
                className="h-1.5"
                indicatorClassName={usagePctBg(d.used_pct)}
              />
              <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
                <span>{formatBytes(d.used_kb)} 已用</span>
                <span>{formatBytes(d.avail_kb)} 可用</span>
                <span>共 {formatBytes(d.total_kb)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      {io.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-0.5">
            实时 I/O
          </h3>
          <Card>
            <CardHeader className="py-2 px-3 space-y-0">
              <CardTitle className="text-xs font-medium flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" />
                设备吞吐
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-1 pt-0">
              <table className="w-full text-[11px]">
                <thead className="text-[10px] uppercase text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-1 font-medium">设备</th>
                    <th className="text-right px-2 py-1 font-medium">读</th>
                    <th className="text-right px-2 py-1 font-medium">写</th>
                    <th className="text-right px-2 py-1 font-medium">IOPS</th>
                    <th className="text-right px-3 py-1 font-medium">繁忙</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {io.map((d) => (
                    <tr key={d.device} className="hover:bg-muted/50">
                      <td className="px-3 py-1 font-mono truncate max-w-[6rem]" title={d.device}>
                        {d.device}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums font-mono">
                        {formatBps(d.read_bps)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums font-mono">
                        {formatBps(d.write_bps)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                        {d.read_iops + d.write_iops}
                      </td>
                      <td className={"px-3 py-1 text-right tabular-nums " + usagePctTone(d.util_pct)}>
                        {Math.round(d.util_pct)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}
