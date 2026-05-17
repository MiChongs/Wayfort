"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { insightsService, type ProcessSort } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { OverviewTab } from "./overview-tab"
import { ProcessesTab } from "./processes-tab"
import { NetworkTab } from "./network-tab"
import { DisksTab } from "./disks-tab"
import {
  RefreshControl,
  loadDefaultInterval,
  saveDefaultInterval,
  type RefreshInterval,
} from "./refresh-control"

export interface InsightsPanelProps {
  nodeId: number
  collapsed?: boolean
  onToggleCollapse?: () => void
}

type TabKey = "overview" | "processes" | "network" | "disks"

/**
 * The right-hand panel on /nodes/[id]/ssh — a tabbed live dashboard of
 * system metrics polled from the gateway's insights API. The user picks a
 * refresh interval (default 5s, persisted to localStorage); the query keys
 * are scoped per-tab so switching tabs doesn't refetch unrelated data.
 */
export function InsightsPanel({ nodeId, collapsed, onToggleCollapse }: InsightsPanelProps) {
  const [tab, setTab] = React.useState<TabKey>("overview")
  const [interval, setInterval] = React.useState<RefreshInterval>(() => loadDefaultInterval())
  const [procSort, setProcSort] = React.useState<ProcessSort>("cpu")
  const qc = useQueryClient()

  const handleIntervalChange = React.useCallback((v: RefreshInterval) => {
    setInterval(v)
    saveDefaultInterval(v)
  }, [])

  // System snapshot is the spine — overview / disks read directly, network
  // also pulls per-interface data from here, and processes-tab uses the
  // generated_at to show a stale indicator.
  const systemQ = useQuery({
    queryKey: ["insights", "system", nodeId],
    queryFn: () => insightsService.system(nodeId),
    refetchInterval: interval > 0 ? interval : false,
    refetchIntervalInBackground: false,
    staleTime: 1000,
    enabled: !collapsed,
  })

  // Only poll processes when its tab is visible — the payload is the largest
  // (up to 200 rows × 9 columns) and the query is cheap to skip.
  const procsQ = useQuery({
    queryKey: ["insights", "processes", nodeId, procSort],
    queryFn: () => insightsService.processes(nodeId, procSort, 100),
    refetchInterval: interval > 0 && tab === "processes" ? interval : false,
    refetchIntervalInBackground: false,
    staleTime: 1000,
    enabled: !collapsed && (tab === "processes" || tab === "overview"),
  })

  const netQ = useQuery({
    queryKey: ["insights", "network", nodeId],
    queryFn: () => insightsService.network(nodeId),
    refetchInterval: interval > 0 && tab === "network" ? interval : false,
    refetchIntervalInBackground: false,
    staleTime: 1000,
    enabled: !collapsed && tab === "network",
  })

  const handleManualRefresh = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["insights", "system", nodeId] })
    void qc.invalidateQueries({ queryKey: ["insights", "processes", nodeId] })
    void qc.invalidateQueries({ queryKey: ["insights", "network", nodeId] })
  }, [qc, nodeId])

  const handleJumpToProcesses = React.useCallback((sort: "cpu" | "mem") => {
    setProcSort(sort)
    setTab("processes")
  }, [])

  // Use the most recent generated_at from whichever query is currently
  // active so the "X 秒前" indicator reflects real freshness.
  const lastUpdated =
    tab === "network"
      ? netQ.data?.generated_at
      : tab === "processes"
        ? procsQ.data?.generated_at
        : systemQ.data?.generated_at

  const refreshing = systemQ.isFetching || procsQ.isFetching || netQ.isFetching
  const firstError = systemQ.error || procsQ.error || netQ.error

  if (collapsed) {
    return (
      <div className="h-full w-full flex items-start justify-center pt-2 bg-muted/20 border-l border-border/60">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onToggleCollapse}
          aria-label="展开仪表盘"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background border-l border-border/60 min-w-0">
      <div className="border-b border-border/60 px-2 py-1.5 flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onToggleCollapse}
          aria-label="收起仪表盘"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </Button>
        <div className="text-xs font-medium">系统仪表盘</div>
        <div className="ml-auto">
          <RefreshControl
            interval={interval}
            onChange={handleIntervalChange}
            onManualRefresh={handleManualRefresh}
            refreshing={refreshing}
            lastUpdated={lastUpdated}
          />
        </div>
      </div>

      {firstError && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="px-3 py-2 text-[11px] bg-destructive/10 border-b border-destructive/30 text-destructive flex items-start gap-2"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">采集失败</div>
            <div className="opacity-80 break-words">{(firstError as Error).message}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={handleManualRefresh}
          >
            重试
          </Button>
        </motion.div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-2 mt-2 h-8 bg-transparent border-b border-border/60 rounded-none p-0">
          <TabsTrigger value="overview" className="text-xs">概览</TabsTrigger>
          <TabsTrigger value="processes" className="text-xs">进程</TabsTrigger>
          <TabsTrigger value="network" className="text-xs">网络</TabsTrigger>
          <TabsTrigger value="disks" className="text-xs">磁盘</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex-1 overflow-auto mt-0">
          <OverviewTab
            system={systemQ.data}
            processes={procsQ.data}
            onJumpToProcesses={handleJumpToProcesses}
          />
        </TabsContent>
        <TabsContent
          value="processes"
          className={cn("flex-1 mt-0 min-h-0", tab === "processes" ? "flex flex-col" : "")}
        >
          <ProcessesTab
            data={procsQ.data}
            sort={procSort}
            onSortChange={setProcSort}
          />
        </TabsContent>
        <TabsContent value="network" className="flex-1 mt-0 min-h-0 flex flex-col">
          <NetworkTab network={netQ.data} system={systemQ.data} />
        </TabsContent>
        <TabsContent value="disks" className="flex-1 overflow-auto mt-0">
          <DisksTab system={systemQ.data} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
