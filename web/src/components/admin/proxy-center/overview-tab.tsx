"use client"

import * as React from "react"
import { CheckCircle2, Layers } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ProxyChainSummary } from "@/components/admin/proxy-chain-builder"
import type { Proxy, ProxyChainTemplate } from "@/lib/api/types"
import { KIND_LABEL } from "../proxy-kind"
import { HealthDot } from "../proxy-health/health-dot"
import { LatencyBadge } from "../proxy-health/latency-badge"
import { useProxyHealthCtx } from "../proxy-health/health-context"

export function OverviewTab({
  proxies,
  templates,
}: {
  proxies: Proxy[]
  templates: ProxyChainTemplate[]
}) {
  const health = useProxyHealthCtx()

  const attention = React.useMemo(() => {
    return proxies
      .map((p) => ({ p, h: health.byId(p.id) }))
      .filter(({ h }) => h && (h.state === "down" || h.state === "degraded"))
      .sort((a, b) => (a.h!.state === "down" ? -1 : 1) - (b.h!.state === "down" ? -1 : 1))
  }, [proxies, health])

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">需要关注</CardTitle>
        </CardHeader>
        <CardContent>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-success" /> 所有代理状态正常。
            </div>
          ) : (
            <ul className="space-y-1.5">
              {attention.map(({ p, h }) => (
                <li key={p.id} className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
                  <HealthDot state={h!.state} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                  <span className="text-[10px] text-muted-foreground">{KIND_LABEL[p.kind]}</span>
                  <LatencyBadge ms={h!.latency_ms} />
                  {h!.last_error && (
                    <span className="max-w-[40%] truncate text-[11px] text-destructive" title={h!.last_error}>
                      {h!.last_error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4" /> 常用模板
          </CardTitle>
        </CardHeader>
        <CardContent>
          {templates.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">还没有保存的链路模板。</p>
          ) : (
            <ul className="space-y-2">
              {templates.slice(0, 6).map((t) => (
                <li key={t.id} className="space-y-1 rounded-md border border-border bg-card px-3 py-2">
                  <div className="text-sm font-medium">{t.name}</div>
                  <ProxyChainSummary chain={t.chain} proxies={proxies} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
