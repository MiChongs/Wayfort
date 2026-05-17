"use client"

import * as React from "react"
import { HardDrive } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { SystemSnapshot } from "@/lib/api/services"
import { formatBytes, usagePctBg, usagePctTone } from "./format"

export interface DisksTabProps {
  system?: SystemSnapshot
}

export function DisksTab({ system }: DisksTabProps) {
  if (!system) {
    return <div className="p-4 text-sm text-muted-foreground">采集中…</div>
  }
  const disks = system.disks.slice().sort((a, b) => b.used_pct - a.used_pct)
  if (disks.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">无挂载点信息</div>
  }
  return (
    <div className="p-3 space-y-2">
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
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={"h-full transition-[width] " + usagePctBg(d.used_pct)}
                style={{ width: `${Math.min(100, d.used_pct)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
              <span>{formatBytes(d.used_kb)} 已用</span>
              <span>{formatBytes(d.avail_kb)} 可用</span>
              <span>共 {formatBytes(d.total_kb)}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
