"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  FileCode2,
  Loader2,
  Network,
  Plus,
  Users,
  Waypoints,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/admin/use-confirm"
import { StatCard } from "@/components/insights/stat-card"
import { Sparkline } from "@/components/insights/sparkline"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { useInsightsHistory } from "@/lib/hooks/use-insights-history"
import { wireguardService, type WGIface, type WGStatus } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "./_shared"
import { wireguardStreamURL, wireguardApplyStreamURL } from "./_live"
import { CreateIfaceWizard, EditIfaceDialog, IfaceCard } from "./wireguard/iface"
import { PeersView } from "./wireguard/peers"
import { GatewayView } from "./wireguard/gateway"
import { ConfigView } from "./wireguard/config-view"
import { InstallPanel } from "./wireguard/install"
import { WgTopology } from "./wireguard/topology"
import { StreamConsole } from "./wireguard/stream-console"
import { errorHint, fmtBytes, peerOnline, SectionHeader, useElementWidth, WgEmpty, type WgView } from "./wireguard/shared"

type Props = { nodeId: number; tabId: string; active: boolean }

const VIEWS: { key: WgView; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "overview", label: "概览", icon: Activity },
  { key: "interfaces", label: "接口", icon: Waypoints },
  { key: "peers", label: "对端", icon: Users },
  { key: "gateway", label: "网关", icon: Network },
  { key: "config", label: "配置", icon: FileCode2 },
]

function onErr(e: ApiError) {
  toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message })
}

export function WireGuardTab({ nodeId, tabId, active }: Props) {
  const url = React.useMemo(() => wireguardStreamURL(nodeId), [nodeId])
  const { data, status, error } = useSseSnapshot<WGStatus>(url, { enabled: active })
  const [view, setView] = React.useState<WgView>("overview")
  const [peerIface, setPeerIface] = React.useState<string | undefined>(undefined)

  if (!active) return null
  if (status === "error" && !data) return <WgEmpty title="无法读取 WireGuard" sub={error} />
  if (!data) {
    return (
      <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> 采集中…
      </div>
    )
  }
  if (!data.installed) {
    return <InstallPanel nodeId={nodeId} tabId={tabId} active={active} reason={data.reason} />
  }

  const ifaces = data.ifaces ?? []
  const gotoPeers = (iface: string) => {
    setPeerIface(iface)
    setView("peers")
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WgViewNav value={view} onChange={setView} />
      <div className="min-h-0 flex-1">
        {view === "overview" && (
          <OverviewView data={data} ifaces={ifaces} onPeerClick={(iface) => gotoPeers(iface)} onCreate={() => setView("interfaces")} />
        )}
        {view === "interfaces" && <InterfacesView nodeId={nodeId} tabId={tabId} ifaces={ifaces} onViewPeers={gotoPeers} />}
        {view === "peers" && <PeersView nodeId={nodeId} tabId={tabId} ifaces={ifaces} initialIface={peerIface} />}
        {view === "gateway" && <GatewayView nodeId={nodeId} tabId={tabId} active={active} />}
        {view === "config" && <ConfigView nodeId={nodeId} tabId={tabId} ifaces={ifaces} active={active} />}
      </div>
    </div>
  )
}

// ---- segmented nav (icon-only when narrow) ----

function WgViewNav({ value, onChange }: { value: WgView; onChange: (v: WgView) => void }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const compact = width > 0 && width < 360
  return (
    <div ref={ref} className="flex items-center gap-1 border-b bg-card px-2 py-1.5">
      {VIEWS.map((v) => {
        const Icon = v.icon
        const on = value === v.key
        return (
          <button
            key={v.key}
            type="button"
            onClick={() => onChange(v.key)}
            title={v.label}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors",
              on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {!compact && <span>{v.label}</span>}
          </button>
        )
      })}
    </div>
  )
}

// ---- overview ----

function OverviewView({
  data,
  ifaces,
  onPeerClick,
  onCreate,
}: {
  data: WGStatus
  ifaces: WGIface[]
  onPeerClick: (iface: string) => void
  onCreate: () => void
}) {
  const [topoIface, setTopoIface] = React.useState(ifaces[0]?.name ?? "")
  React.useEffect(() => {
    if (!ifaces.find((i) => i.name === topoIface) && ifaces[0]) setTopoIface(ifaces[0].name)
  }, [ifaces, topoIface])

  const totals = React.useMemo(() => {
    let rx = 0
    let tx = 0
    let peers = 0
    let online = 0
    let ports = 0
    for (const i of ifaces) {
      if (i.up) ports++
      for (const p of i.peers ?? []) {
        peers++
        rx += p.transfer_rx
        tx += p.transfer_tx
        if (peerOnline(p.latest_handshake)) online++
      }
    }
    return { rx, tx, peers, online, ports, upIfaces: ifaces.filter((i) => i.up).length }
  }, [ifaces])

  const rxHist = useInsightsHistory(data, () => totals.rx)
  const txHist = useInsightsHistory(data, () => totals.tx)

  if (ifaces.length === 0) {
    return (
      <WgEmpty
        title="还没有 WireGuard 接口"
        sub="创建第一个接口，即可开始添加对端、生成客户端二维码。"
        action={
          <Button size="sm" className="h-7 gap-1 text-xs" onClick={onCreate}>
            <Plus className="h-3.5 w-3.5" /> 新建接口
          </Button>
        }
      />
    )
  }

  const iface = ifaces.find((i) => i.name === topoIface)

  return (
    <div className="h-full min-h-0 space-y-3 overflow-auto p-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard icon={Waypoints} label="接口" value={ifaces.length} hint={`${totals.upIfaces} 运行中`} tone={totals.upIfaces > 0 ? "success" : "default"} />
        <StatCard icon={Users} label="在线对端" value={`${totals.online}/${totals.peers}`} tone={totals.online > 0 ? "success" : totals.peers > 0 ? "warning" : "default"} />
        <StatCard icon={ArrowDownToLine} label="总下行" value={fmtBytes(totals.rx)}>
          <Sparkline data={rxHist} color="var(--chart-2)" height={26} />
        </StatCard>
        <StatCard icon={ArrowUpFromLine} label="总上行" value={fmtBytes(totals.tx)}>
          <Sparkline data={txHist} color="var(--chart-1)" height={26} />
        </StatCard>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">拓扑</span>
        {ifaces.length > 1 && (
          <select
            value={topoIface}
            onChange={(e) => setTopoIface(e.target.value)}
            className="h-6 rounded-md border bg-card px-1.5 font-mono text-[11px]"
          >
            {ifaces.map((i) => (
              <option key={i.name} value={i.name}>{i.name}</option>
            ))}
          </select>
        )}
      </div>
      {iface && <WgTopology iface={iface} onPeerClick={() => onPeerClick(iface.name)} />}
    </div>
  )
}

// ---- interfaces ----

function InterfacesView({
  nodeId,
  tabId,
  ifaces,
  onViewPeers,
}: {
  nodeId: number
  tabId: string
  ifaces: WGIface[]
  onViewPeers: (iface: string) => void
}) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [editName, setEditName] = React.useState<string | null>(null)
  const [applyName, setApplyName] = React.useState<string | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wg", nodeId] })

  const toggle = useMutation({
    mutationFn: ({ name, up }: { name: string; up: boolean }) => wireguardService.setIface(nodeId, name, up),
    onSuccess: (_d, v) => {
      toast.success(`${v.name} 已${v.up ? "启动" : "停止"}`)
      void invalidate()
    },
    onError: onErr,
  })
  const autostart = useMutation({
    mutationFn: ({ name, on }: { name: string; on: boolean }) => wireguardService.setAutostart(nodeId, name, on),
    onSuccess: () => void invalidate(),
    onError: onErr,
  })
  const del = useMutation({
    mutationFn: (name: string) => wireguardService.deleteIface(nodeId, name, true),
    onSuccess: (_d, name) => {
      toast.success(`接口 ${name} 已删除（已备份）`)
      void invalidate()
    },
    onError: onErr,
  })

  const onToggle = async (name: string, up: boolean) => {
    if (!up) {
      const ok = await confirm({
        title: `停止 ${name}？`,
        description: "停止该接口会断开其隧道，远端对端将失联。",
        confirmLabel: "停止",
      })
      if (!ok) return
    }
    toggle.mutate({ name, up })
  }
  const onDelete = async (name: string) => {
    const ok = await confirm({
      title: `删除接口 ${name}？`,
      description: "将停止并禁用该接口、备份后删除其配置文件。可从备份恢复。",
      confirmLabel: "删除",
    })
    if (ok) del.mutate(name)
  }

  const busy = toggle.isPending || autostart.isPending || del.isPending

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <SectionHeader title="接口" count={`${ifaces.length}`}>
        <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" /> 新建接口
        </Button>
      </SectionHeader>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {ifaces.length === 0 ? (
          <WgEmpty title="暂无接口" sub="点击右上角「新建接口」开始。" />
        ) : (
          ifaces.map((ifc) => (
            <IfaceCard
              key={ifc.name}
              ifc={ifc}
              busy={busy}
              tabId={tabId}
              onToggle={onToggle}
              onToggleAutostart={(name, on) => autostart.mutate({ name, on })}
              onEdit={(name) => setEditName(name)}
              onDelete={onDelete}
              onApply={(name) => setApplyName(name)}
              onViewPeers={onViewPeers}
            />
          ))
        )}
      </div>

      <CreateIfaceWizard nodeId={nodeId} open={createOpen} onClose={() => setCreateOpen(false)} />
      {editName && <EditIfaceDialog nodeId={nodeId} name={editName} open onClose={() => setEditName(null)} />}
      <StreamConsole
        open={applyName !== null}
        title={`应用配置 · ${applyName ?? ""}`}
        description="wg syncconf 热同步，不断开隧道。"
        url={applyName ? wireguardApplyStreamURL(nodeId, applyName, "sync") : ""}
        onClose={() => setApplyName(null)}
      />
    </div>
  )
}
