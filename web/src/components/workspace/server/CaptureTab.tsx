"use client"

import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Virtuoso } from "react-virtuoso"
import { Download, Loader2, Radio, Wifi } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { captureService, type CaptureOpts } from "@/lib/api/services"
import { codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|password is required/i.test(msg))
    return "tcpdump 需 root / sudo NOPASSWD。换 root 凭据或配置 sudoers。"
  if (code === "unreachable") return "节点 SSH 不可达。"
  if (code === "bad_request") return "网卡名或 BPF 过滤格式不合法。"
  return ""
}

function downloadBase64(b64: string, filename: string) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const blob = new Blob([bytes], { type: "application/vnd.tcpdump.pcap" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export function CaptureTab({ nodeId, active }: Props) {
  const [iface, setIface] = React.useState("")
  const [filter, setFilter] = React.useState("")
  const [count, setCount] = React.useState(200)

  const ifaces = useQuery({ queryKey: ["capture", nodeId, "ifaces"], queryFn: () => captureService.interfaces(nodeId), enabled: active, retry: false })
  React.useEffect(() => {
    const list = ifaces.data?.ifaces ?? []
    if (!iface && list.length) setIface(list.find((x) => x !== "lo") ?? list[0])
  }, [ifaces.data, iface])

  const opts = (): CaptureOpts => ({ iface, filter: filter.trim(), count, seconds: 20 })

  const run = useMutation({
    mutationFn: () => captureService.run(nodeId, opts()),
    onError: (e: ApiError) => toast.error("抓包失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })
  const pcap = useMutation({
    mutationFn: () => captureService.pcap(nodeId, opts()),
    onSuccess: (r) => { downloadBase64(r.base64, r.filename); toast.success(`已下载 ${r.filename}`, { description: `${(r.bytes / 1024).toFixed(1)} KB · 可用 Wireshark 打开` }) },
    onError: (e: ApiError) => toast.error("下载失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  if (!active) return null

  const list = ifaces.data?.ifaces ?? []
  const lines = run.data?.lines ?? []
  const busy = run.isPending || pcap.isPending

  if (ifaces.data && !ifaces.data.has_tcpdump) {
    return (
      <div className="space-y-2 p-6 text-center text-sm text-muted-foreground">
        <Radio className="mx-auto h-8 w-8 opacity-50" />
        <div className="font-medium text-foreground">未安装 tcpdump</div>
        <div className="text-xs">在该节点安装 tcpdump 后可抓包。</div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b bg-card px-3 py-2">
        <Radio className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-xs font-medium">抓包分析</span>
      </header>

      <div className="space-y-1.5 border-b p-2">
        <div className="flex items-center gap-1.5">
          <Select value={iface} onValueChange={setIface}>
            <SelectTrigger className="h-7 w-28 shrink-0 gap-1 border-border/60 text-[11px]"><SelectValue placeholder="网卡" /></SelectTrigger>
            <SelectContent>{list.map((i) => <SelectItem key={i} value={i} className="font-mono text-xs">{i}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="BPF 过滤，如 tcp port 443" className="h-7 min-w-0 flex-1 text-xs font-mono" />
          <Select value={String(count)} onValueChange={(v) => setCount(Number(v))}>
            <SelectTrigger className="h-7 w-20 shrink-0 gap-1 border-border/60 text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{[100, 200, 500, 1000].map((n) => <SelectItem key={n} value={String(n)} className="text-xs">{n} 包</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" className="h-7 flex-1 text-xs" disabled={!iface || busy} onClick={() => run.mutate()}>
            {run.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> 抓取中(≤20s)…</> : <><Wifi className="h-3.5 w-3.5" /> 抓包</>}
          </Button>
          <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" disabled={!iface || busy} onClick={() => pcap.mutate()} title="抓取并下载 .pcap（可用 Wireshark 打开）">
            {pcap.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} pcap
          </Button>
        </div>
        {run.data && <div className="text-[10px] text-muted-foreground">{run.data.count} 个数据包</div>}
      </div>

      <div className="min-h-0 flex-1 bg-muted/40">
        {run.isPending ? (
          <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 抓取中…</div>
        ) : !run.data ? (
          <div className="p-6 text-center text-xs text-muted-foreground">选择网卡与过滤条件，点「抓包」。抓取在该节点上运行 tcpdump（有界，≤20s 或 N 包）。</div>
        ) : lines.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">未捕获到数据包（无匹配流量，或权限不足）。</div>
        ) : (
          <Virtuoso
            data={lines}
            className="no-scrollbar h-full font-mono text-[10px] leading-5"
            itemContent={(_i, l) => <div className="whitespace-pre-wrap break-all px-3 py-px">{l}</div>}
          />
        )}
      </div>
    </div>
  )
}
