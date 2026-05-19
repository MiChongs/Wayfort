"use client"

// Per-node port-forward activity panel for the workspace tab. Lists this
// node's active forwarders as live-card tiles (byte rate / connections /
// 60 s sparkline) and exposes an inline "new forward" form using the
// shared TTL presets. The page-level grid is at /port-forwards; this
// scoped panel keeps the operator inside the workspace.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Plus, RefreshCw, Share2 } from "lucide-react"
import { toast } from "sonner"
import { AnimatePresence, motion } from "motion/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ForwardLiveCard } from "@/components/portfwd/ForwardLiveCard"
import {
  PortForwardEventsProvider,
  useForwardEventsLatency,
  useForwardEventsStatus,
} from "@/hooks/use-portfwd-events"
import { portfwdService } from "@/lib/api/services"

const TTL_PRESETS: Array<{ label: string; value: string }> = [
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
]

type Props = {
  nodeId: number
}

export function TcpForwardPanel({ nodeId }: Props) {
  return (
    <PortForwardEventsProvider>
      <Inner nodeId={nodeId} />
    </PortForwardEventsProvider>
  )
}

function Inner({ nodeId }: Props) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["portfwd"],
    queryFn: portfwdService.list,
  })
  const eventsStatus = useForwardEventsStatus()
  const eventsLatency = useForwardEventsLatency()

  const [ttl, setTtl] = React.useState("1h")
  const [label, setLabel] = React.useState("")
  const [pinned, setPinned] = React.useState(false)

  const create = useMutation({
    mutationFn: () =>
      portfwdService.create({
        node_id: nodeId,
        ttl: ttl || undefined,
        label: label.trim() || undefined,
        pinned,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["portfwd"] })
      setLabel("")
      setPinned(false)
      toast.success("已开端口转发")
    },
    onError: (e: { message?: string }) =>
      toast.error("申请失败", { description: e?.message }),
  })

  const mine = React.useMemo(
    () => (list.data?.port_forwards ?? []).filter((p) => p.node_id === nodeId),
    [list.data, nodeId],
  )
  const sorted = React.useMemo(
    () =>
      [...mine].sort((a, b) => {
        if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0)) return a.pinned ? -1 : 1
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      }),
    [mine],
  )

  return (
    <div className="h-full flex flex-col bg-background overflow-y-auto">
      <div className="p-5 border-b bg-card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-base font-semibold inline-flex items-center gap-2">
            <Share2 className="w-4 h-4" /> 端口转发
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant={eventsStatus === "open" ? "success" : "outline"} className="text-[10px]">
              {eventsStatus === "open"
                ? eventsLatency !== null
                  ? `实时 · ${eventsLatency}ms`
                  : "实时"
                : eventsStatus === "connecting"
                  ? "连接中"
                  : "离线"}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => list.refetch()}
              className="h-7"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${list.isFetching ? "animate-spin" : ""}`} /> 刷新
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          在网关本地开监听，把流量转到本节点。本地客户端直接连
          <code className="font-mono mx-1">127.0.0.1:&lt;port&gt;</code>。
        </p>
        <div className="space-y-2">
          <div className="flex items-end gap-2 flex-wrap">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">TTL</Label>
              <div className="flex items-center gap-2">
                <ToggleGroup
                  type="single"
                  value={ttl}
                  onValueChange={(v) => v && setTtl(v)}
                  variant="outline"
                  size="sm"
                >
                  {TTL_PRESETS.map((p) => (
                    <ToggleGroupItem key={p.value} value={p.value} className="h-7 px-2">
                      {p.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <Input
                  value={ttl}
                  onChange={(e) => setTtl(e.target.value)}
                  className="h-7 w-24"
                  placeholder="自定义"
                />
              </div>
            </div>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="标签 (可选)"
              className="h-7 w-44"
            />
            <label className="inline-flex items-center gap-1 text-xs">
              <Checkbox checked={pinned} onCheckedChange={(v) => setPinned(v === true)} />
              置顶
            </label>
            <Button
              size="sm"
              onClick={() => create.mutate()}
              disabled={create.isPending}
              className="h-7"
            >
              {create.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}{" "}
              新建
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-5 space-y-3">
        {list.isLoading ? (
          <div className="text-sm text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-lg border-2 border-dashed p-10 text-center text-muted-foreground text-sm">
            还没有针对本节点的端口转发。点上方「新建」开一条。
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <AnimatePresence initial={false}>
              {sorted.map((p) => (
                <motion.div
                  key={p.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                >
                  <ForwardLiveCard forward={p} compact />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}
