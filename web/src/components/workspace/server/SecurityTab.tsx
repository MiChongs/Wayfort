"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { securityService } from "@/lib/api/services"
import type { SecCheck, SecStatus } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { RunInTerminalButton, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

const RANK: Record<SecStatus, number> = { danger: 0, warn: 1, info: 2, ok: 3, unknown: 4 }

function statusMeta(s: SecStatus) {
  switch (s) {
    case "danger": return { icon: XCircle, tone: "text-destructive", label: "危险" }
    case "warn": return { icon: AlertTriangle, tone: "text-warning", label: "注意" }
    case "ok": return { icon: CheckCircle2, tone: "text-success", label: "通过" }
    default: return { icon: Info, tone: "text-muted-foreground", label: "信息" }
  }
}

function scoreTone(score: number): string {
  if (score >= 85) return "text-success"
  if (score >= 60) return "text-warning"
  return "text-destructive"
}

export function SecurityTab({ nodeId, tabId, active }: Props) {
  const report = useQuery({
    queryKey: ["security", nodeId],
    queryFn: () => securityService.report(nodeId),
    enabled: active,
    refetchInterval: 60_000,
    retry: false,
  })

  if (!active) return null
  if (report.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <ShieldCheck className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法运行安全检查</div>
        <div className="text-xs">{(report.error as ApiError)?.message}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => report.refetch()}><RefreshCw className="w-3 h-3" /> 重试</Button>
      </div>
    )
  }
  const d = report.data
  const checks = (d?.checks ?? []).slice().sort((a, b) => RANK[a.status] - RANK[b.status])

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldCheck className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">安全态势</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => report.refetch()} title="重新检查"><RefreshCw className={cn("w-3 h-3", report.isFetching && "animate-spin")} /></Button>
      </header>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {!d ? (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4"><Loader2 className="w-3 h-3 animate-spin" /> 扫描中…</div>
        ) : (
          <>
            <Card>
              <CardContent className="px-3 py-3 flex items-center gap-3">
                <div className={cn("text-3xl font-medium tabular-nums", scoreTone(d.score))}>{d.score}</div>
                <div className="text-[11px] text-muted-foreground">
                  <div>安全评分 / 100</div>
                  <div>{checks.filter((c) => c.status === "danger").length} 危险 · {checks.filter((c) => c.status === "warn").length} 注意</div>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-1.5">
              {checks.map((c) => <CheckRow key={c.id} c={c} tabId={tabId} />)}
            </div>

            <div className="text-[10px] text-muted-foreground">
              ⓘ 仅检测、不自动修改系统。点「修复」会把建议命令打到终端，由你确认执行。
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CheckRow({ c, tabId }: { c: SecCheck; tabId: string }) {
  const meta = statusMeta(c.status)
  const Icon = meta.icon
  const hasItems = (c.items?.length ?? 0) > 0
  return (
    <Card>
      <CardContent className="px-3 py-2">
        <div className="flex items-start gap-2">
          <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", meta.tone)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{c.title}</span>
              <Badge variant="outline" className={cn("text-[9px] px-1 h-4", meta.tone)}>{meta.label}</Badge>
            </div>
            {c.detail && <div className="text-[11px] text-muted-foreground mt-0.5">{c.detail}</div>}
            {hasItems && (
              <Collapsible>
                <CollapsibleTrigger className="text-[10px] text-primary hover:underline mt-1">查看 {c.items!.length} 项</CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 bg-muted/60 rounded-md p-2 text-[10px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">{c.items!.join("\n")}</pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
          {c.fix && <RunInTerminalButton tabId={tabId} command={c.fix} label="把修复命令送到终端" />}
        </div>
      </CardContent>
    </Card>
  )
}
