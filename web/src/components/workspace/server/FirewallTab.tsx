"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Plus, Power, RefreshCw, Shield, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { firewallService } from "@/lib/api/services"
import type { FirewallRuleSpec } from "@/lib/api/types"

type Props = {
  nodeId: number
  active: boolean
}

// FirewallTab — ufw / firewalld / iptables management.
// Reads cached 5s by react-query; writes always invalidate the cache.
export function FirewallTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ["firewall", nodeId, "status"],
    queryFn: () => firewallService.status(nodeId),
    enabled: active,
    refetchInterval: 30_000,
  })
  const rules = useQuery({
    queryKey: ["firewall", nodeId, "rules"],
    queryFn: () => firewallService.listRules(nodeId),
    enabled: active && (status.data?.tool ?? "") !== "",
    refetchInterval: 30_000,
  })

  const [adding, setAdding] = React.useState(false)

  const invalidate = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["firewall", nodeId] })
  }, [nodeId, qc])

  const deleteRule = useMutation({
    mutationFn: (index: number) => firewallService.deleteRule(nodeId, index),
    onSuccess: () => {
      toast.success("已删除规则")
      invalidate()
    },
    onError: (e: { message?: string }) => toast.error("删除失败", { description: e?.message }),
  })

  const setEnabled = useMutation({
    mutationFn: (on: boolean) =>
      on ? firewallService.enable(nodeId) : firewallService.disable(nodeId),
    onSuccess: (_data, on) => {
      toast.success(on ? "已启用防火墙" : "已停用防火墙")
      invalidate()
    },
    onError: (e: { message?: string }) =>
      toast.error("切换失败", { description: e?.message }),
  })

  if (!active) return null

  if (status.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="w-4 h-4 animate-spin" /> 检测防火墙工具中…
      </div>
    )
  }

  if (status.isError) {
    return (
      <div className="p-6 text-sm">
        <div className="text-destructive mb-2">查询失败</div>
        <div className="text-xs text-muted-foreground break-words">
          {(status.error as { message?: string })?.message || "未知错误"}
        </div>
      </div>
    )
  }

  const s = status.data
  if (!s || s.tool === "") {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Shield className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">未检测到防火墙工具</div>
        <div className="text-xs">{s?.reason || "节点上未安装 ufw / firewalld / iptables"}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Shield className="w-4 h-4 text-primary" />
          <Badge variant="outline" className="text-[10px] uppercase">
            {s.tool}
          </Badge>
          <Badge variant={s.active ? "success" : "secondary"}>
            {s.active ? "active" : "inactive"}
          </Badge>
          {s.policy && (
            <span className="text-[10px] text-muted-foreground truncate">{s.policy}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {s.tool !== "iptables" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setEnabled.mutate(!s.active)}
              disabled={setEnabled.isPending}
            >
              <Power className="w-3 h-3" /> {s.active ? "停用" : "启用"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setAdding(true)}
          >
            <Plus className="w-3 h-3" /> 添加
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => invalidate()}
            title="刷新"
          >
            <RefreshCw className={`w-3 h-3 ${status.isFetching || rules.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        {rules.isLoading && (
          <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> 加载规则…
          </div>
        )}
        {rules.data && rules.data.rules.length === 0 && (
          <div className="text-xs text-muted-foreground p-6 text-center">
            没有规则。点上方"添加"创建第一条。
          </div>
        )}
        {rules.data && rules.data.rules.length > 0 && (
          <table className="w-full text-xs">
            <thead className="bg-muted/50 sticky top-0 text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1.5 w-8">#</th>
                <th className="text-left px-2 py-1.5 w-16">动作</th>
                <th className="text-left px-2 py-1.5 w-14">方向</th>
                <th className="text-left px-2 py-1.5 w-14">协议</th>
                <th className="text-left px-2 py-1.5">端口</th>
                <th className="text-left px-2 py-1.5">来源</th>
                <th className="px-2 py-1.5 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rules.data.rules.map((r) => (
                <tr key={r.index} className="hover:bg-accent/40" title={r.raw}>
                  <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{r.index}</td>
                  <td className="px-2 py-1.5">
                    <Badge variant={r.action === "ALLOW" ? "success" : "destructive"}>
                      {r.action}
                    </Badge>
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{r.direction || "—"}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{r.protocol || "any"}</td>
                  <td className="px-2 py-1.5 font-mono">{r.port || "any"}</td>
                  <td className="px-2 py-1.5 font-mono truncate max-w-[10rem]">{r.source || "Anywhere"}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      title="删除规则"
                      onClick={() => {
                        if (confirm(`删除规则 ${r.index}?`)) deleteRule.mutate(r.index)
                      }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AddRuleDialog
        open={adding}
        nodeId={nodeId}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false)
          invalidate()
        }}
      />
    </div>
  )
}

function AddRuleDialog({
  open,
  nodeId,
  onClose,
  onAdded,
}: {
  open: boolean
  nodeId: number
  onClose: () => void
  onAdded: () => void
}) {
  const [action, setAction] = React.useState<"ALLOW" | "DENY" | "REJECT">("ALLOW")
  const [protocol, setProtocol] = React.useState<"tcp" | "udp">("tcp")
  const [port, setPort] = React.useState("")
  const [source, setSource] = React.useState("")

  React.useEffect(() => {
    if (open) {
      setAction("ALLOW")
      setProtocol("tcp")
      setPort("")
      setSource("")
    }
  }, [open])

  const submit = useMutation({
    mutationFn: (spec: FirewallRuleSpec) => firewallService.addRule(nodeId, spec),
    onSuccess: () => {
      toast.success("已添加规则")
      onAdded()
    },
    onError: (e: { message?: string }) =>
      toast.error("添加失败", { description: e?.message }),
  })

  const invalid = !port.trim() || submit.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加防火墙规则</DialogTitle>
          <DialogDescription>
            规则会落到节点上的 ufw / firewalld / iptables；操作会被审计记录。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">动作</Label>
              <Select value={action} onValueChange={(v) => setAction(v as "ALLOW" | "DENY" | "REJECT")}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALLOW">ALLOW（放行）</SelectItem>
                  <SelectItem value="DENY">DENY（丢弃）</SelectItem>
                  <SelectItem value="REJECT">REJECT（拒绝）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">协议</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as "tcp" | "udp")}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp">TCP</SelectItem>
                  <SelectItem value="udp">UDP</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="fw-port">
              端口 *
            </Label>
            <Input
              id="fw-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22 / 80,443 / 8000:9000"
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="fw-source">
              来源 CIDR（可空 = Anywhere）
            </Label>
            <Input
              id="fw-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="10.0.0.0/8"
              className="font-mono"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submit.isPending}>
            取消
          </Button>
          <Button
            onClick={() =>
              submit.mutate({
                action,
                protocol,
                port: port.trim(),
                source: source.trim() || undefined,
                direction: "in",
              })
            }
            disabled={invalid}
          >
            {submit.isPending ? "添加中…" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
