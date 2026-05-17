"use client"

import * as React from "react"
import { Network as NetworkIcon, Search as SearchIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { InsightsIface, NetworkSnapshot, SystemSnapshot } from "@/lib/api/services"
import { formatBps, formatBytes } from "./format"

export interface NetworkTabProps {
  network?: NetworkSnapshot
  system?: SystemSnapshot
}

export function NetworkTab({ network, system }: NetworkTabProps) {
  return (
    <Tabs defaultValue="listen" className="flex-1 flex flex-col h-full">
      <TabsList className="mx-2 mt-2 bg-transparent border-b border-border/60 rounded-none h-8 p-0">
        <TabsTrigger value="listen" className="text-xs">
          监听端口
        </TabsTrigger>
        <TabsTrigger value="iface" className="text-xs">
          网络接口
        </TabsTrigger>
      </TabsList>
      <TabsContent value="listen" className="flex-1 overflow-hidden mt-0">
        <ListenersList network={network} />
      </TabsContent>
      <TabsContent value="iface" className="flex-1 overflow-auto mt-0 p-3 space-y-2">
        <InterfaceList system={system} />
      </TabsContent>
    </Tabs>
  )
}

function ListenersList({ network }: { network?: NetworkSnapshot }) {
  const [filter, setFilter] = React.useState("")
  const filtered = React.useMemo(() => {
    const list = network?.listeners ?? []
    if (!filter) return list
    const q = filter.toLowerCase()
    return list.filter(
      (l) =>
        (l.process || "").toLowerCase().includes(q) ||
        String(l.local_port).includes(q) ||
        l.local_addr.toLowerCase().includes(q) ||
        l.proto.toLowerCase().includes(q),
    )
  }, [network, filter])

  if (!network) return <div className="p-4 text-sm text-muted-foreground">采集中…</div>

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-border/60 flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="过滤进程 / 端口 / 协议…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Badge variant="outline" className="text-[10px]">
          共 {network.listeners.length}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          ESTABLISHED {network.established}
        </Badge>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="sticky top-0 bg-background border-b border-border/60">
            <tr className="text-muted-foreground">
              <th className="px-2 py-1.5 text-left w-16">协议</th>
              <th className="px-2 py-1.5 text-left">本地地址</th>
              <th className="px-2 py-1.5 text-right w-16">端口</th>
              <th className="px-2 py-1.5 text-left w-24">PID</th>
              <th className="px-2 py-1.5 text-left">进程</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted-foreground">
                  无匹配
                </td>
              </tr>
            ) : (
              filtered.map((l, i) => (
                <tr key={i} className="border-b border-border/30 hover:bg-muted/60">
                  <td className="px-2 py-1">
                    <Badge variant="outline" className="text-[10px] h-4 px-1">
                      {l.proto}
                    </Badge>
                  </td>
                  <td className="px-2 py-1 truncate max-w-[140px]" title={l.local_addr}>
                    {l.local_addr || "*"}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{l.local_port}</td>
                  <td className="px-2 py-1 tabular-nums text-muted-foreground">
                    {l.pid || "—"}
                  </td>
                  <td className="px-2 py-1">{l.process || "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function InterfaceList({ system }: { system?: SystemSnapshot }) {
  if (!system) return <div className="text-sm text-muted-foreground">采集中…</div>
  if (system.interfaces.length === 0)
    return <div className="text-sm text-muted-foreground">无网络接口</div>
  return (
    <>
      {system.interfaces.map((ni) => (
        <InterfaceCard key={ni.name} iface={ni} />
      ))}
    </>
  )
}

function InterfaceCard({ iface }: { iface: InsightsIface }) {
  const stateClass =
    iface.oper_state === "UP"
      ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/40"
      : iface.oper_state === "DOWN"
        ? "bg-rose-500/20 text-rose-600 dark:text-rose-400 border-rose-500/40"
        : "bg-muted text-muted-foreground border-border/60"
  return (
    <Card>
      <CardHeader className="py-2 px-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-xs font-medium flex items-center gap-1.5">
          <NetworkIcon className="w-3.5 h-3.5" />
          {iface.name}
        </CardTitle>
        <Badge className={cn("text-[10px] h-4 px-1.5 border", stateClass)}>
          {iface.oper_state}
        </Badge>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-0 text-[11px] space-y-1">
        {iface.ipv4 && <Row k="IPv4" v={iface.ipv4} mono />}
        {iface.ipv6 && <Row k="IPv6" v={iface.ipv6} mono />}
        {iface.mac && <Row k="MAC" v={iface.mac} mono />}
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 pt-1">
          <Row k="↓ 速率" v={formatBps(iface.rx_bps)} mono />
          <Row k="↑ 速率" v={formatBps(iface.tx_bps)} mono />
          <Row k="↓ 累计" v={formatBytes(iface.rx_bytes / 1024)} mono />
          <Row k="↑ 累计" v={formatBytes(iface.tx_bytes / 1024)} mono />
        </div>
      </CardContent>
    </Card>
  )
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[60px_1fr] gap-x-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn("truncate", mono && "font-mono")}>{v}</span>
    </div>
  )
}
