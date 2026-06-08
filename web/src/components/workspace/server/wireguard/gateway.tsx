"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Network, Route, ShieldCheck } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useConfirm } from "@/components/admin/use-confirm"
import { wireguardService } from "@/lib/api/services"
import { codeOf, RunInTerminalButton, type ApiError } from "../_shared"
import { errorHint } from "./shared"

function onErr(e: ApiError) {
  toast.error("操作失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message })
}

export function GatewayView({ nodeId, tabId, active }: { nodeId: number; tabId: string; active: boolean }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const gw = useQuery({
    queryKey: ["wg", nodeId, "gateway"],
    queryFn: () => wireguardService.gateway(nodeId),
    enabled: active,
  })
  const [egress, setEgress] = React.useState("")
  React.useEffect(() => {
    if (gw.data && !egress) setEgress(gw.data.egress_iface || gw.data.egress_candidates?.[0] || "")
  }, [gw.data, egress])

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wg", nodeId, "gateway"] })

  const forwarding = useMutation({
    mutationFn: (persist: boolean) => wireguardService.setForwarding(nodeId, persist),
    onSuccess: () => {
      toast.success("已开启 IP 转发")
      void invalidate()
    },
    onError: onErr,
  })
  const nat = useMutation({
    mutationFn: (enable: boolean) => wireguardService.setNat(nodeId, enable, egress, true),
    onSuccess: (_d, enable) => {
      toast.success(enable ? "NAT 已开启" : "NAT 已关闭")
      void invalidate()
    },
    onError: onErr,
  })

  const onToggleNat = async (enable: boolean) => {
    const ok = await confirm({
      title: enable ? "开启 NAT 网关？" : "关闭 NAT？",
      description: enable
        ? `将对出口网卡 ${egress || "(未选择)"} 添加 MASQUERADE 规则并开启 IP 转发，使对端经本机出网。`
        : "将移除 MASQUERADE 规则，对端将无法经本机出网。",
      confirmLabel: enable ? "开启" : "关闭",
      destructive: !enable,
    })
    if (ok) nat.mutate(enable)
  }

  if (!active) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {gw.isLoading && !gw.data ? (
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 读取网关状态…</div>
        ) : (
          <>
            <Card>
              <CardContent className="space-y-2 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <Route className="h-3.5 w-3.5 text-primary" /> IP 转发
                  </div>
                  {gw.data?.ip_forward ? (
                    <Badge className="h-4 border-success/40 bg-success/[0.08] px-1.5 text-[10px] text-success">已开启</Badge>
                  ) : (
                    <Badge className="h-4 border-destructive/40 bg-destructive/[0.08] px-1.5 text-[10px] text-destructive">未开启</Badge>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  net.ipv4.ip_forward {gw.data?.ip_forward_persisted ? "· 已持久化" : "· 未持久化"}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" className="h-7 gap-1 text-xs" disabled={forwarding.isPending} onClick={() => forwarding.mutate(true)}>
                    {forwarding.isPending && <Loader2 className="h-3 w-3 animate-spin" />} 开启并持久化
                  </Button>
                  <RunInTerminalButton tabId={tabId} command="sysctl -w net.ipv4.ip_forward=1" run={false} label="改到终端" size="sm" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-2 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <Network className="h-3.5 w-3.5 text-primary" /> NAT / MASQUERADE
                  </div>
                  <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <Switch checked={!!gw.data?.nat_enabled} disabled={nat.isPending || !egress} onCheckedChange={onToggleNat} />
                    {gw.data?.nat_enabled ? "已开启" : "关闭"}
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">出口网卡</span>
                  <Select value={egress} onValueChange={setEgress}>
                    <SelectTrigger className="h-7 w-32 text-xs"><SelectValue placeholder="选择网卡" /></SelectTrigger>
                    <SelectContent>
                      {(gw.data?.egress_candidates ?? []).map((d) => (
                        <SelectItem key={d} value={d} className="font-mono text-xs">{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {gw.data?.rules && gw.data.rules.length > 0 && (
                  <pre className="max-h-24 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[10px] text-muted-foreground">{gw.data.rules.join("\n")}</pre>
                )}
              </CardContent>
            </Card>

            <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
              <ShieldCheck className="h-3 w-3" /> 推荐在「新建接口」时直接勾选 NAT，规则会随接口启停自动加/删，无需在此手动维护。
            </div>
          </>
        )}
      </div>
    </div>
  )
}
