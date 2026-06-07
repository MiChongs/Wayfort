"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Cpu, Loader2, MemoryStick, RefreshCw, Thermometer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { hardwareService } from "@/lib/api/services"
import type { Hardware } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { type ApiError } from "./_shared"
import { LiveKpiStrip } from "./_live"

type Props = { nodeId: number; active: boolean }

export function HardwareTab({ nodeId, active }: Props) {
  const hw = useQuery({
    queryKey: ["hardware", nodeId],
    queryFn: () => hardwareService.info(nodeId),
    enabled: active,
    staleTime: 60_000,
    retry: false,
  })

  if (!active) return null

  if (hw.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Cpu className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法读取硬件信息</div>
        <div className="text-xs">{(hw.error as ApiError)?.message}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => hw.refetch()}>
          <RefreshCw className="w-3 h-3" /> 重试
        </Button>
      </div>
    )
  }

  const d: Hardware | undefined = hw.data

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Cpu className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">硬件信息</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => hw.refetch()} title="刷新">
          <RefreshCw className={cn("w-3 h-3", hw.isFetching && "animate-spin")} />
        </Button>
      </header>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        <LiveKpiStrip nodeId={nodeId} active={active} />
        {!d ? (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4"><Loader2 className="w-3 h-3 animate-spin" /> 采集中…</div>
        ) : (
          <>
            {d.notes && <div className="text-[11px] text-muted-foreground border rounded-md p-2">{d.notes}</div>}

            <Card>
              <CardHeader className="py-2 px-3 space-y-0">
                <CardTitle className="text-xs font-medium flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5" /> 处理器</CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-[11px]">
                {Object.entries(d.cpu).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <span className="text-muted-foreground truncate" title={k}>{k}</span>
                    <span className="font-mono truncate" title={v}>{v}</span>
                  </React.Fragment>
                ))}
                {Object.keys(d.cpu).length === 0 && <span className="col-span-2 text-muted-foreground">lscpu 不可用</span>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-2 px-3 space-y-0">
                <CardTitle className="text-xs font-medium flex items-center gap-1.5"><MemoryStick className="w-3.5 h-3.5" /> 内存</CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 space-y-1.5">
                {d.mem_summary && <div className="font-mono text-[11px] text-muted-foreground">{d.mem_summary}</div>}
                {(d.mem_modules?.length ?? 0) > 0 && (
                  <table className="w-full text-[11px]">
                    <thead className="text-[10px] uppercase text-muted-foreground">
                      <tr><th className="text-left py-1">插槽</th><th className="text-left py-1">容量</th><th className="text-left py-1">类型</th><th className="text-left py-1">频率</th></tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {d.mem_modules!.map((m, i) => (
                        <tr key={i}>
                          <td className="py-1 font-mono">{m.locator}</td>
                          <td className="py-1">{m.size}</td>
                          <td className="py-1 text-muted-foreground">{m.type || "—"}</td>
                          <td className="py-1 text-muted-foreground">{m.speed || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {Object.keys(d.bios).length > 0 && (
              <Card>
                <CardHeader className="py-2 px-3 space-y-0"><CardTitle className="text-xs font-medium">系统 / BIOS</CardTitle></CardHeader>
                <CardContent className="px-3 pb-3 pt-0 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-[11px]">
                  {Object.entries(d.bios).map(([k, v]) => (
                    <React.Fragment key={k}>
                      <span className="text-muted-foreground">{k}</span>
                      <span className="font-mono truncate" title={v}>{v}</span>
                    </React.Fragment>
                  ))}
                </CardContent>
              </Card>
            )}

            {(d.sensors?.length ?? 0) > 0 && (
              <Card>
                <CardHeader className="py-2 px-3 space-y-0"><CardTitle className="text-xs font-medium flex items-center gap-1.5"><Thermometer className="w-3.5 h-3.5" /> 传感器</CardTitle></CardHeader>
                <CardContent className="px-3 pb-3 pt-0">
                  <pre className="font-mono text-[10px] whitespace-pre-wrap leading-5 max-h-40 overflow-auto">{d.sensors!.join("\n")}</pre>
                </CardContent>
              </Card>
            )}

            <RawList title={`PCI 设备 (${d.pci?.length ?? 0})`} items={d.pci ?? []} />
            <RawList title={`USB 设备 (${d.usb?.length ?? 0})`} items={d.usb ?? []} />
          </>
        )}
      </div>
    </div>
  )
}

function RawList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <Collapsible>
      <Card>
        <CollapsibleTrigger className="w-full">
          <CardHeader className="py-2 px-3 space-y-0">
            <CardTitle className="text-xs font-medium text-left">{title}</CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="px-3 pb-3 pt-0">
            <pre className="font-mono text-[10px] whitespace-pre-wrap leading-5 max-h-60 overflow-auto">{items.join("\n")}</pre>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
