"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/common/copy-button"
import { firewallService } from "@/lib/api/services"
import { SectionHeader } from "./shared"

export function DiagnoseView({ nodeId, active }: { nodeId: number; active: boolean }) {
  const d = useQuery({
    queryKey: ["fw", nodeId, "diagnose"],
    queryFn: () => firewallService.diagnose(nodeId),
    enabled: active,
  })
  if (!active) return null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader title="诊断">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => d.refetch()}><RefreshCw className="h-3.5 w-3.5" /></Button>
        {d.data && <CopyButton value={JSON.stringify(d.data, null, 2)} className="h-7 w-7" />}
      </SectionHeader>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-xs">
        {d.isLoading ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 探测中…</span>
        ) : d.data ? (
          <>
            <Row label="UID" value={`${d.data.uid}${d.data.is_root ? " (root)" : ""}`} />
            <Row label="sudo 可用" value={d.data.sudo_available ? "是" : "否"} />
            <Row label="选用工具" value={d.data.selected_tool || "无"} />
            {d.data.sudo_nopasswd_tools && d.data.sudo_nopasswd_tools.length > 0 && (
              <Row label="NOPASSWD" value={d.data.sudo_nopasswd_tools.join(", ")} />
            )}
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">检出工具</div>
              <div className="flex flex-wrap gap-1">
                {(d.data.tools_found ?? []).map((t) => <Badge key={t} variant="outline" className="font-mono text-[10px]">{t}</Badge>)}
              </div>
            </div>
            {d.data.last_error && <div className="text-destructive">{d.data.last_error}</div>}
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">探测原文（{d.data.elapsed_ms}ms）</div>
              <pre className="max-h-[40vh] overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[10px] text-muted-foreground">{d.data.probe_raw}</pre>
            </div>
          </>
        ) : (
          <span className="text-destructive">{d.error instanceof Error ? d.error.message : "诊断失败"}</span>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/50 py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px]">{value}</span>
    </div>
  )
}
