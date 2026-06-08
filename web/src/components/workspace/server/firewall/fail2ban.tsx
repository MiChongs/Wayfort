"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, ShieldBan, ShieldOff } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useConfirm } from "@/components/admin/use-confirm"
import { firewallService } from "@/lib/api/services"
import type { Fail2banJail } from "@/lib/api/types"
import { RunInTerminalButton } from "../_shared"
import { codeOf, type ApiError } from "../_shared"
import { fail2banInstallStreamURL } from "../_live"
import { StreamConsole } from "../wireguard/stream-console"
import { errorHint, FwIconEmpty, SectionHeader } from "./shared"

function onErr(e: ApiError) {
  toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message })
}

export function Fail2banView({ nodeId, tabId, active }: { nodeId: number; tabId: string; active: boolean }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [installing, setInstalling] = React.useState(false)
  const [banIP, setBanIP] = React.useState("")
  const [banJail, setBanJail] = React.useState("")

  const f2b = useQuery({
    queryKey: ["fw", nodeId, "fail2ban"],
    queryFn: () => firewallService.fail2ban(nodeId),
    enabled: active,
    refetchInterval: active ? 10_000 : false,
  })

  const unban = useMutation({
    mutationFn: (v: { jail: string; ip: string }) => firewallService.fail2banUnban(nodeId, v.jail, v.ip),
    onSuccess: () => { toast.success("已解封"); void qc.invalidateQueries({ queryKey: ["fw", nodeId, "fail2ban"] }) },
    onError: onErr,
  })
  const ban = useMutation({
    mutationFn: (v: { jail: string; ip: string }) => firewallService.fail2banBan(nodeId, v.jail, v.ip),
    onSuccess: () => { toast.success("已封禁"); setBanIP(""); void qc.invalidateQueries({ queryKey: ["fw", nodeId, "fail2ban"] }) },
    onError: onErr,
  })

  if (!active) return null
  if (f2b.isLoading) return <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 读取 fail2ban…</div>

  if (f2b.data && !f2b.data.installed) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <FwIconEmpty title="未安装 fail2ban" sub="fail2ban 自动封禁暴力破解来源。可一键安装。" />
        <div className="mx-auto -mt-6 flex items-center gap-2 pb-6">
          <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setInstalling(true)}><ShieldBan className="h-3.5 w-3.5" /> 一键安装</Button>
          <RunInTerminalButton tabId={tabId} command="apt-get install -y fail2ban || dnf install -y fail2ban" run={false} label="改到终端" size="sm" />
        </div>
        <StreamConsole open={installing} title="安装 fail2ban" url={fail2banInstallStreamURL(nodeId)} onClose={() => setInstalling(false)} onComplete={() => void f2b.refetch()} />
      </div>
    )
  }

  const jails = f2b.data?.jails ?? []
  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <SectionHeader title="fail2ban" count={`${jails.length} jail`}>
        <Badge className={f2b.data?.running ? "h-4 border-success/40 bg-success/[0.08] px-1.5 text-[10px] text-success" : "h-4 px-1.5 text-[10px]"}>
          {f2b.data?.running ? "运行中" : "未运行"}
        </Badge>
      </SectionHeader>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        <div className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5">
          <span className="text-[10px] text-muted-foreground">手动封禁</span>
          <select value={banJail} onChange={(e) => setBanJail(e.target.value)} className="h-6 rounded border bg-card px-1 text-[11px]">
            <option value="">选 jail</option>
            {jails.map((j) => <option key={j.name} value={j.name}>{j.name}</option>)}
          </select>
          <Input value={banIP} onChange={(e) => setBanIP(e.target.value)} placeholder="IP" className="h-6 flex-1 font-mono text-[11px]" />
          <Button size="sm" className="h-6 px-2 text-[10px]" disabled={!banJail || !banIP.trim() || ban.isPending} onClick={() => ban.mutate({ jail: banJail, ip: banIP.trim() })}>封禁</Button>
        </div>
        {jails.map((j) => <JailCard key={j.name} jail={j} onUnban={(ip) => confirm({ title: `解封 ${ip}？`, destructive: false, confirmLabel: "解封" }).then((ok) => ok && unban.mutate({ jail: j.name, ip }))} />)}
        {jails.length === 0 && <FwIconEmpty title="无 jail" sub="fail2ban 已安装但没有启用的 jail。" />}
      </div>
    </div>
  )
}

function JailCard({ jail, onUnban }: { jail: Fail2banJail; onUnban: (ip: string) => void }) {
  const ips = jail.banned_ips ?? []
  return (
    <Card>
      <CardContent className="space-y-1.5 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs font-medium">{jail.name}</span>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">封禁 {jail.banned}</Badge>
            {jail.total_failed ? <span>累计失败 {jail.total_failed}</span> : null}
          </div>
        </div>
        {ips.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {ips.map((ip) => (
              <span key={ip} className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                {ip}
                <button type="button" title="解封" className="opacity-70 hover:opacity-100" onClick={() => onUnban(ip)}><ShieldOff className="h-2.5 w-2.5" /></button>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-[10px] text-muted-foreground">无封禁 IP</div>
        )}
      </CardContent>
    </Card>
  )
}
