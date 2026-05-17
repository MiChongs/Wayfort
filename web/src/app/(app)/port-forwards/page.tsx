"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, RefreshCw, Share2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { meService, portfwdService } from "@/lib/api/services"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { fullTime, fmtBytes, relTime } from "@/lib/format"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"

export default function PortForwardsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["portfwd"], queryFn: portfwdService.list })
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })

  const [open, setOpen] = React.useState(false)
  const [nodeId, setNodeId] = React.useState("")
  const [ttl, setTtl] = React.useState("1h")

  const create = useMutation({
    mutationFn: () => portfwdService.create(Number(nodeId), ttl),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["portfwd"] }); setOpen(false); toast.success("已开端口转发") },
    onError: (e: unknown) => toast.error("申请失败", { description: (e as Error).message }),
  })
  const close = useMutation({
    mutationFn: (id: string) => portfwdService.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["portfwd"] }); toast.success("已释放") },
  })

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Share2 className="w-5 h-5" /> 端口转发
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            在网关本地开监听，把流量转到目标节点。适合 mysql / RDP / 任意 TCP，本地客户端直接连
            <code className="font-mono mx-1">127.0.0.1:&lt;port&gt;</code>。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => list.refetch()}>
            <RefreshCw className="w-4 h-4" /> 刷新
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="w-4 h-4" /> 新建</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>申请端口转发</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label>目标节点</Label>
                  <Select value={nodeId} onValueChange={setNodeId}>
                    <SelectTrigger><SelectValue placeholder="选择一个节点" /></SelectTrigger>
                    <SelectContent>
                      {(nodes.data?.nodes || []).map((n) => (
                        <SelectItem key={n.id} value={String(n.id)}>
                          {n.name} ({n.host}:{n.port}) · {n.protocol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>TTL（如 30m / 1h / 24h）</Label>
                  <Input value={ttl} onChange={(e) => setTtl(e.target.value)} />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
                <Button disabled={!nodeId || create.isPending} onClick={() => create.mutate()}>申请</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {(list.data?.port_forwards?.length ?? 0) === 0 && !list.isLoading ? (
        <EmptyState
          icon={Share2}
          title="还没有活动转发"
          description="点「新建」选一个节点，会把目标的 TCP 端口暴露到网关本地 127.0.0.1。"
        />
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">本地</th>
                <th className="text-left px-3 py-2">目标</th>
                <th className="text-left px-3 py-2">状态</th>
                <th className="text-left px-3 py-2 hidden lg:table-cell">流量</th>
                <th className="text-left px-3 py-2">过期</th>
                <th className="text-right px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.port_forwards || []).map((p) => {
                const localAddr = `${p.local_host}:${p.local_port}`
                return (
                  <tr key={p.id} className="border-t hover:bg-accent/30">
                    <td className="px-3 py-2 font-mono">
                      <div className="flex items-center gap-1">
                        <span>{localAddr}</span>
                        <CopyButton value={localAddr} />
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono">{p.target_host}:{p.target_port}</td>
                    <td className="px-3 py-2">
                      <Badge variant={p.status === "active" ? "success" : "outline"}>{p.status}</Badge>
                    </td>
                    <td className="px-3 py-2 hidden lg:table-cell text-xs text-muted-foreground">
                      ↑{fmtBytes(p.bytes_in)} ↓{fmtBytes(p.bytes_out)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div>{fullTime(p.expires_at)}</div>
                      <div className="text-muted-foreground">{relTime(p.expires_at)}</div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost" size="icon"
                        onClick={async () => {
                          const ok = await confirmDialog({ title: "释放该转发？" })
                          if (ok) close.mutate(p.id)
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                )
              })}
              {list.isLoading && <tr><td colSpan={6} className="text-center text-muted-foreground py-6">加载中…</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
