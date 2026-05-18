"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Plus, RefreshCw, Share2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CopyButton } from "@/components/common/copy-button"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { portfwdService } from "@/lib/api/services"

type Props = {
  nodeId: number
}

// Workspace tab variant of the port-forwards page, scoped to a single node.
// Lists this node's active forwards and lets the user create / drop them
// inline; no navigation away from the workspace.
export function TcpForwardPanel({ nodeId }: Props) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["portfwd"], queryFn: portfwdService.list })
  const [ttl, setTtl] = React.useState("1h")

  const create = useMutation({
    mutationFn: () => portfwdService.create(nodeId, ttl),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["portfwd"] })
      toast.success("已开端口转发")
    },
    onError: (e: { message?: string }) => toast.error("申请失败", { description: e?.message }),
  })
  const close = useMutation({
    mutationFn: (id: string) => portfwdService.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["portfwd"] })
      toast.success("已释放")
    },
  })

  const mine = (list.data?.port_forwards ?? []).filter((p) => p.node_id === nodeId)

  return (
    <div className="h-full flex flex-col bg-background overflow-y-auto">
      <div className="p-5 border-b bg-card">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            <Share2 className="w-4 h-4" /> 端口转发
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => list.refetch()}
            className="h-7"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${list.isFetching ? "animate-spin" : ""}`} /> 刷新
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          在网关本地开监听，把流量转到本节点。本地客户端直接连
          <code className="font-mono mx-1">127.0.0.1:&lt;port&gt;</code>。
        </p>
        <div className="flex items-end gap-2 flex-wrap">
          <div className="space-y-1">
            <Label htmlFor="ttl" className="text-xs text-muted-foreground">
              TTL（如 30m / 1h / 24h）
            </Label>
            <Input
              id="ttl"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              className="h-8 w-32"
            />
          </div>
          <Button
            size="sm"
            onClick={() => create.mutate()}
            disabled={create.isPending}
          >
            {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} 新建转发
          </Button>
        </div>
      </div>

      <div className="flex-1 p-5">
        {list.isLoading ? (
          <div className="text-sm text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        ) : mine.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed p-10 text-center text-muted-foreground text-sm">
            还没有针对本节点的端口转发。点上方"新建转发"开一条。
          </div>
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
                {mine.map((p) => {
                  const local = `${p.local_host}:${p.local_port}`
                  return (
                    <tr key={p.id} className="border-t hover:bg-accent/30">
                      <td className="px-3 py-2 font-mono">
                        <div className="flex items-center gap-1">
                          <span>{local}</span>
                          <CopyButton value={local} />
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {p.target_host}:{p.target_port}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={p.status === "active" ? "success" : "outline"}>
                          {p.status}
                        </Badge>
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
                          variant="ghost"
                          size="icon"
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
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
