"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Loader2, Power, PowerOff, Shield, Waypoints } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useConfirm } from "@/components/admin/use-confirm"
import { VirtualTable } from "@/components/common/virtual-table"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { formatBytes } from "@/components/insights/format"
import { wireguardService, type WGIface, type WGStatus } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "./_shared"
import { wireguardStreamURL } from "./_live"

type Props = { nodeId: number; tabId: string; active: boolean }

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|root|password is required/i.test(msg))
    return "wg-quick 需 root / sudo NOPASSWD。换 root 凭据或为 wg-quick 配置 sudoers。"
  if (code === "unreachable") return "节点 SSH 不可达，检查节点状态与凭据。"
  return ""
}

// Freshness of the last handshake → warm tone. Fresh (<3m) sage, stale amber,
// cold/never destructive — the fastest read of peer liveness.
function handshakeAge(ts: number): { text: string; tone: string } {
  if (!ts) return { text: "从未", tone: "text-muted-foreground" }
  const age = Math.floor(Date.now() / 1000) - ts
  if (age < 0) return { text: "刚刚", tone: "text-success" }
  let text: string
  if (age < 60) text = `${age}s 前`
  else if (age < 3600) text = `${Math.floor(age / 60)}m 前`
  else if (age < 86400) text = `${Math.floor(age / 3600)}h 前`
  else text = `${Math.floor(age / 86400)}d 前`
  const tone = age < 180 ? "text-success" : age < 600 ? "text-warning" : "text-destructive"
  return { text, tone }
}

export function WireGuardTab({ nodeId, active }: Props) {
  const { confirm, dialog } = useConfirm()
  const url = React.useMemo(() => wireguardStreamURL(nodeId), [nodeId])
  const { data, status, error } = useSseSnapshot<WGStatus>(url, { enabled: active })

  const setIface = useMutation({
    mutationFn: ({ name, up }: { name: string; up: boolean }) => wireguardService.setIface(nodeId, name, up),
    onSuccess: (_d, v) => toast.success(`${v.name} 已${v.up ? "启动" : "停止"}`),
    onError: (e: ApiError) => toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  const onToggle = async (name: string, up: boolean) => {
    if (!up) {
      const ok = await confirm({ title: `停止 ${name}？`, description: "停止该 WireGuard 接口会断开其隧道，远端对端将失联。", confirmLabel: "停止" })
      if (!ok) return
    }
    setIface.mutate({ name, up })
  }

  if (!active) return null
  if (status === "error" && !data) return <Center title="无法读取 WireGuard" sub={error} />
  if (!data) {
    return <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 采集中…</div>
  }
  if (!data.available) return <Center title="WireGuard 不可用" sub={data.reason} />

  const ifaces = data.ifaces ?? []
  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <header className="flex items-center gap-2 border-b bg-card px-3 py-2">
        <Shield className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-xs font-medium">WireGuard</span>
        <span className="text-[10px] text-muted-foreground">{ifaces.length} 接口</span>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {ifaces.map((ifc) => (
          <IfaceCard key={ifc.name} ifc={ifc} busy={setIface.isPending} onToggle={onToggle} />
        ))}
      </div>
    </div>
  )
}

function IfaceCard({ ifc, busy, onToggle }: { ifc: WGIface; busy: boolean; onToggle: (name: string, up: boolean) => void }) {
  const peers = ifc.peers ?? []
  return (
    <Card>
      <CardContent className="space-y-2 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Waypoints className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="font-mono text-xs font-medium">{ifc.name}</span>
            {ifc.listen_port > 0 && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">:{ifc.listen_port}</Badge>}
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{peers.length} 对端</Badge>
          </div>
          <div className="inline-flex shrink-0 gap-0.5">
            <Button variant="ghost" size="icon" className="h-6 w-6" title="启动 (wg-quick up)" disabled={busy} onClick={() => onToggle(ifc.name, true)}><Power className="h-3 w-3" /></Button>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="停止 (wg-quick down)" disabled={busy} onClick={() => onToggle(ifc.name, false)}><PowerOff className="h-3 w-3" /></Button>
          </div>
        </div>
        {ifc.public_key && (
          <div className="truncate font-mono text-[10px] text-muted-foreground" title={ifc.public_key}>pub {ifc.public_key}</div>
        )}
        {peers.length > 0 && (
          <div className="h-[min(320px,40vh)] min-h-0 overflow-hidden rounded-md border">
            <VirtualTable
              rows={peers}
              empty="无对端"
              header={
                <>
                  <th className="px-2 py-1.5 text-left">对端</th>
                  <th className="px-2 py-1.5 text-left">端点</th>
                  <th className="px-2 py-1.5 text-right">握手</th>
                  <th className="px-2 py-1.5 text-right">↓ / ↑</th>
                </>
              }
              renderRow={(p) => {
                const hs = handshakeAge(p.latest_handshake)
                const ips = p.allowed_ips ?? []
                return (
                  <>
                    <td className="max-w-[8rem] truncate px-2 py-1 font-mono text-[10px]" title={p.public_key}>
                      {p.public_key.slice(0, 12)}…
                      {ips.length > 0 && <div className="truncate text-[9px] text-muted-foreground" title={ips.join(", ")}>{ips.join(", ")}</div>}
                    </td>
                    <td className="max-w-[9rem] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground" title={p.endpoint}>{p.endpoint || "—"}</td>
                    <td className={cn("whitespace-nowrap px-2 py-1 text-right text-[10px] tabular-nums", hs.tone)}>{hs.text}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
                      {formatBytes(p.transfer_rx / 1024)} / {formatBytes(p.transfer_tx / 1024)}
                    </td>
                  </>
                )
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Center({ title, sub }: { title: string; sub?: string | null }) {
  return (
    <div className="space-y-2 p-6 text-center text-sm text-muted-foreground">
      <Shield className="mx-auto h-8 w-8 opacity-50" />
      <div className="font-medium text-foreground">{title}</div>
      {sub && <div className="text-xs">{sub}</div>}
    </div>
  )
}
