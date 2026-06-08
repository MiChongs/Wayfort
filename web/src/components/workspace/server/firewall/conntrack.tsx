"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { VirtualTable } from "@/components/common/virtual-table"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import type { ConntrackSnapshot, FirewallConn } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { firewallConntrackStreamURL } from "../_live"
import { fmtBytes, SectionHeader } from "./shared"

export function ConntrackView({ nodeId, active }: { nodeId: number; active: boolean }) {
  const url = React.useMemo(() => firewallConntrackStreamURL(nodeId), [nodeId])
  const { data, status } = useSseSnapshot<ConntrackSnapshot>(url, { enabled: active })
  const [q, setQ] = React.useState("")
  const [state, setState] = React.useState("all")

  const conns = data?.connections ?? []
  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    return conns.filter((c) => {
      if (state !== "all" && (c.state ?? "") !== state) return false
      if (!needle) return true
      return `${c.src} ${c.dst} ${c.dst_port ?? ""}`.toLowerCase().includes(needle)
    })
  }, [conns, q, state])

  const states = React.useMemo(() => Array.from(new Set(conns.map((c) => c.state).filter(Boolean))) as string[], [conns])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader title="活动连接" count={data ? `${rows.length}/${data.total}${data.truncated ? "+" : ""}` : undefined}>
        {status !== "live" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </SectionHeader>
      <div className="flex items-center gap-1.5 border-b bg-card/60 px-3 py-1.5">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 IP / 端口" className="h-7 flex-1 text-xs" />
        <Select value={state} onValueChange={setState}>
          <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {states.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="min-h-0 flex-1">
        <VirtualTable<FirewallConn>
          rows={rows}
          empty={status === "live" ? "无活动连接" : "采集中…"}
          header={
            <>
              <th className="px-2 py-1.5 text-left">协议</th>
              <th className="px-2 py-1.5 text-left">源</th>
              <th className="px-2 py-1.5 text-left">目标</th>
              <th className="px-2 py-1.5 text-left">端口</th>
              <th className="px-2 py-1.5 text-left">状态</th>
              <th className="px-2 py-1.5 text-right">流量</th>
            </>
          }
          renderRow={(c) => (
            <>
              <td className="px-2 py-1 text-[10px] uppercase text-muted-foreground">{c.proto}</td>
              <td className="max-w-[9rem] truncate px-2 py-1 font-mono text-[10px]" title={`${c.src}:${c.src_port ?? ""}`}>{c.src}{c.src_port ? `:${c.src_port}` : ""}</td>
              <td className="max-w-[9rem] truncate px-2 py-1 font-mono text-[10px]" title={`${c.dst}:${c.dst_port ?? ""}`}>{c.dst}</td>
              <td className="px-2 py-1 font-mono text-[10px] tabular-nums">{c.dst_port || "—"}</td>
              <td className="px-2 py-1"><span className={cn("text-[9px]", stateTone(c.state))}>{c.state || "—"}</span></td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">{c.bytes ? fmtBytes(c.bytes) : "—"}</td>
            </>
          )}
        />
      </div>
    </div>
  )
}

function stateTone(s?: string): string {
  if (s === "ESTABLISHED") return "text-success"
  if (s?.startsWith("SYN")) return "text-warning"
  return "text-muted-foreground"
}
