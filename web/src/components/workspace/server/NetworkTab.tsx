"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import {
  Loader2,
  Network,
  Play,
  Power,
  PowerOff,
  Search as SearchIcon,
  TerminalSquare,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfirm } from "@/components/admin/use-confirm"
import { VirtualTable } from "@/components/common/virtual-table"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { networkService } from "@/lib/api/services"
import type { NetDiagResult, NetDiagTool, NetInfo } from "@/lib/api/types"
import { useSendToTerminal, codeOf, type ApiError } from "./_shared"
import { LiveKpiStrip, networkStreamURL } from "./_live"

type Props = { nodeId: number; tabId: string; active: boolean }

const TOOLS: { value: NetDiagTool; label: string; ph: string }[] = [
  { value: "ping", label: "ping", ph: "主机或 IP" },
  { value: "traceroute", label: "traceroute", ph: "主机或 IP" },
  { value: "dig", label: "dig", ph: "域名" },
  { value: "curl", label: "curl -I", ph: "https://…" },
  { value: "mtr", label: "mtr", ph: "主机或 IP" },
]

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied") return "改接口状态需 root / sudo NOPASSWD。"
  if (code === "bad_request") return "目标格式不合法。"
  if (code === "unreachable") return "节点 SSH 不可达。"
  return ""
}

export function NetworkToolsTab({ nodeId, tabId, active }: Props) {
  const { confirm, dialog } = useConfirm()
  // Live network snapshot (interfaces + counters + connections) over SSE.
  const url = React.useMemo(() => networkStreamURL(nodeId), [nodeId])
  const { data: d, status, error } = useSseSnapshot<NetInfo>(url, { enabled: active })

  const setIface = useMutation({
    mutationFn: ({ name, up }: { name: string; up: boolean }) => networkService.setIface(nodeId, name, up),
    onSuccess: (_d, v) => toast.success(`${v.name} 已${v.up ? "启用" : "停用"}`),
    onError: (e: ApiError) => toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  const onIface = async (name: string, up: boolean) => {
    if (!up) {
      const ok = await confirm({ title: `停用接口 ${name}？`, description: "若这是你的连接网卡，可能立即断开 SSH。", confirmLabel: "停用" })
      if (!ok) return
    }
    setIface.mutate({ name, up })
  }

  if (!active) return null

  if (status === "error" && !d) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Network className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法读取网络信息</div>
        <div className="text-xs">{error}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <div className="border-b px-2 pb-1.5 pt-2">
        <LiveKpiStrip nodeId={nodeId} active={active} />
      </div>
      <Tabs defaultValue="ifaces" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-2 mt-2 h-8 bg-transparent border-b rounded-none p-0 self-start">
          <TabsTrigger value="ifaces" className="text-xs">接口</TabsTrigger>
          <TabsTrigger value="conns" className="text-xs">连接</TabsTrigger>
          <TabsTrigger value="diag" className="text-xs">诊断</TabsTrigger>
        </TabsList>

        <TabsContent value="ifaces" className="flex-1 min-h-0 mt-0 overflow-auto p-3 space-y-2">
          {!d ? (
            <div className="text-xs text-muted-foreground inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 采集中…</div>
          ) : (
            <>
              {d.ifaces.map((i) => (
                <Card key={i.name}>
                  <CardContent className="px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-xs font-medium">{i.name}</span>
                        <Badge variant={i.state === "UP" ? "success" : i.state === "DOWN" ? "destructive" : "secondary"} className="text-[10px]">{i.state}</Badge>
                        {i.mtu ? <span className="text-[10px] text-muted-foreground">MTU {i.mtu}</span> : null}
                      </div>
                      {i.name !== "lo" && (
                        i.state === "UP" ? (
                          <Button variant="ghost" size="icon" className="h-6 w-6" title="停用接口" disabled={setIface.isPending} onClick={() => onIface(i.name, false)}><PowerOff className="w-3 h-3" /></Button>
                        ) : (
                          <Button variant="ghost" size="icon" className="h-6 w-6" title="启用接口" disabled={setIface.isPending} onClick={() => onIface(i.name, true)}><Power className="w-3 h-3" /></Button>
                        )
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-muted-foreground space-y-0.5">
                      {(i.ipv4 ?? []).map((a) => <div key={a}>{a}</div>)}
                      {(i.ipv6 ?? []).map((a) => <div key={a} className="truncate">{a}</div>)}
                      {i.mac && <div>MAC {i.mac}</div>}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {d.routes.length > 0 && (
                <div className="pt-1">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-0.5 mb-1">路由</div>
                  <table className="w-full text-[10px] font-mono">
                    <tbody className="divide-y divide-border/40">
                      {d.routes.map((r, i) => (
                        <tr key={i}>
                          <td className="py-0.5 pr-2">{r.dst}</td>
                          <td className="py-0.5 pr-2 text-muted-foreground">{r.via ? `via ${r.via}` : ""}</td>
                          <td className="py-0.5 text-muted-foreground">{r.dev}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="conns" className="flex-1 min-h-0 mt-0 flex flex-col">
          <ConnList conns={d?.conns ?? []} loading={!d} />
        </TabsContent>

        <TabsContent value="diag" className="flex-1 min-h-0 mt-0 overflow-auto">
          <DiagPanel nodeId={nodeId} tabId={tabId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ConnList({ conns, loading }: { conns: NetInfo["conns"]; loading: boolean }) {
  const [filter, setFilter] = React.useState("")
  const rows = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return conns
    return conns.filter((c) => c.local.toLowerCase().includes(q) || c.peer.toLowerCase().includes(q) || (c.process || "").toLowerCase().includes(q) || c.state.toLowerCase().includes(q))
  }, [conns, filter])
  return (
    <>
      <div className="p-2 border-b flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="过滤地址/进程/状态…" className="h-7 pl-7 text-xs" />
        </div>
        <Badge variant="outline" className="text-[10px]">{rows.length}</Badge>
      </div>
      <div className="min-h-0 flex-1 font-mono">
        {loading ? (
          <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 加载…</div>
        ) : (
          <VirtualTable<NetInfo["conns"][number]>
            rows={rows}
            empty="无连接"
            header={
              <>
                <th className="px-2 py-1 text-left">协议</th>
                <th className="px-2 py-1 text-left">状态</th>
                <th className="px-2 py-1 text-left">本地</th>
                <th className="px-2 py-1 text-left">对端</th>
                <th className="px-2 py-1 text-left">进程</th>
              </>
            }
            renderRow={(c) => (
              <>
                <td className="px-2 py-0.5 text-[10px]">{c.proto}</td>
                <td className="px-2 py-0.5 text-[10px] text-muted-foreground">{c.state}</td>
                <td className="max-w-[9rem] truncate px-2 py-0.5 text-[10px]" title={c.local}>{c.local}</td>
                <td className="max-w-[9rem] truncate px-2 py-0.5 text-[10px]" title={c.peer}>{c.peer}</td>
                <td className="px-2 py-0.5 text-[10px] text-primary">{c.process || "—"}</td>
              </>
            )}
          />
        )}
      </div>
    </>
  )
}

function DiagPanel({ nodeId, tabId }: { nodeId: number; tabId: string }) {
  const [tool, setTool] = React.useState<NetDiagTool>("ping")
  const [target, setTarget] = React.useState("")
  const [result, setResult] = React.useState<NetDiagResult | null>(null)
  const send = useSendToTerminal(tabId)

  const run = useMutation({
    mutationFn: () => networkService.diagnose(nodeId, tool, target.trim()),
    onSuccess: (r) => setResult(r),
    onError: (e: ApiError) => toast.error("诊断失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  const ph = TOOLS.find((t) => t.value === tool)?.ph ?? ""

  return (
    <div className="p-2 space-y-2">
      <div className="flex items-center gap-1.5">
        <Select value={tool} onValueChange={(v) => setTool(v as NetDiagTool)}>
          <SelectTrigger className="h-7 w-28 gap-1 text-[11px] border-border/60"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TOOLS.map((t) => <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && target.trim()) run.mutate() }}
          placeholder={ph}
          className="h-7 flex-1 text-xs font-mono"
        />
        <Button size="sm" className="h-7 text-xs" disabled={!target.trim() || run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
        </Button>
      </div>
      {result && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground font-mono">{result.tool} {result.target}</span>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => send(`${result.tool === "curl" ? "curl -I" : result.tool} ${result.target}`, true)}>
              <TerminalSquare className="w-3 h-3" /> 改到终端
            </Button>
          </div>
          <pre className="bg-muted/60 rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words leading-5 max-h-[50vh] overflow-auto">{result.output || "（无输出）"}</pre>
        </>
      )}
      {!result && (
        <div className="text-[11px] text-muted-foreground px-1 py-4 text-center">选择工具、输入目标，回车或点运行。诊断在该节点上执行。</div>
      )}
    </div>
  )
}
