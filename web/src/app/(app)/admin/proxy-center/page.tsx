"use client"

// 代理链中心 — the unified ops surface that absorbs the old /admin/proxies and
// /admin/chain-templates pages: live health overview, proxy catalog, reusable
// templates, a read-only topology viewer and connection metrics, all under one
// health subscription.

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "next/navigation"
import { Network } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { ProxyHealthProvider } from "@/components/admin/proxy-health/health-context"
import { ProxyHealthKpiStrip } from "@/components/admin/proxy-health/proxy-health-kpi-strip"
import { OverviewTab } from "@/components/admin/proxy-center/overview-tab"
import { CatalogTab } from "@/components/admin/proxy-center/catalog-tab"
import { TemplatesTab } from "@/components/admin/proxy-center/templates-tab"
import { TopologyTab } from "@/components/admin/proxy-center/topology-tab"
import { MetricsTab } from "@/components/admin/proxy-center/metrics-tab"
import { chainTemplateService, credentialService, proxyService } from "@/lib/api/services"
import type { ProxyMetricsSnapshot } from "@/lib/api/types"

const TABS = ["overview", "catalog", "templates", "topology", "metrics"] as const
type TabKey = (typeof TABS)[number]

export default function ProxyCenterPage() {
  const initialTab = useSearchParams().get("tab")
  const [tab, setTab] = React.useState<TabKey>(
    TABS.includes(initialTab as TabKey) ? (initialTab as TabKey) : "overview",
  )

  const proxies = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })
  const templates = useQuery({ queryKey: ["admin", "chain-templates"], queryFn: chainTemplateService.list })
  const creds = useQuery({ queryKey: ["admin", "credentials"], queryFn: credentialService.list })

  const metricsURL = React.useMemo(() => proxyService.metricsStreamURL(), [])
  const metrics = useSseSnapshot<ProxyMetricsSnapshot>(metricsURL)

  const proxyList = proxies.data?.proxies ?? []
  const templateList = templates.data?.templates ?? []
  const credList = creds.data?.credentials ?? []

  const onTab = (v: string) => {
    setTab(v as TabKey)
    const url = new URL(window.location.href)
    url.searchParams.set("tab", v)
    window.history.replaceState(null, "", url.toString())
  }

  return (
    <ProxyHealthProvider>
      <div className="space-y-4 p-6">
        <div>
          <div className="eyebrow">PROXY CHAIN OPS</div>
          <h1 className="display-title flex items-center gap-2 text-3xl">
            <Network className="h-6 w-6 text-primary" /> 代理链中心
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            统一管理代理、链路模板、实时健康与连接指标——一处编排，全链可观测。
          </p>
        </div>

        <ProxyHealthKpiStrip metrics={metrics.data} />

        <Tabs value={tab} onValueChange={onTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">总览</TabsTrigger>
            <TabsTrigger value="catalog">代理目录</TabsTrigger>
            <TabsTrigger value="templates">模板</TabsTrigger>
            <TabsTrigger value="topology">拓扑</TabsTrigger>
            <TabsTrigger value="metrics">指标</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab proxies={proxyList} templates={templateList} />
          </TabsContent>
          <TabsContent value="catalog">
            <CatalogTab
              proxies={proxyList}
              credentials={credList}
              summary={proxies.data?.summary}
              loading={proxies.isLoading}
            />
          </TabsContent>
          <TabsContent value="templates">
            <TemplatesTab templates={templateList} proxies={proxyList} loading={templates.isLoading} />
          </TabsContent>
          <TabsContent value="topology">
            <TopologyTab templates={templateList} proxies={proxyList} />
          </TabsContent>
          <TabsContent value="metrics">
            <MetricsTab metrics={metrics.data} proxies={proxyList} />
          </TabsContent>
        </Tabs>
      </div>
    </ProxyHealthProvider>
  )
}
