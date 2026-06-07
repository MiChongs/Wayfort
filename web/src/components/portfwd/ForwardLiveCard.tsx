"use client"

// Activity card for a single forwarder. Shows local→target, live byte
// rate, active connection count, cumulative bytes, expiry countdown, and
// a 60 s sparkline of total throughput. Composes shadcn Card + Badge +
// the shared insights Sparkline so the visual language matches the rest
// of the dashboard.

import * as React from "react"
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Clock,
  Copy,
  ExternalLink,
  Loader2,
  Trash2,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { motion } from "motion/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Sparkline } from "@/components/insights/sparkline"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { fmtBytes, relTime } from "@/lib/format"
import { portfwdService } from "@/lib/api/services"
import type { PortForward } from "@/lib/api/types"
import { useForwardLive } from "@/hooks/use-portfwd-events"

const STATUS_LABEL: Record<PortForward["status"], string> = {
  active: "活动",
  expired: "已过期",
  closed: "已关闭",
  port_unavailable: "端口占用",
}

const STATUS_TONE: Record<PortForward["status"], "success" | "outline" | "destructive"> = {
  active: "success",
  expired: "outline",
  closed: "outline",
  port_unavailable: "destructive",
}

function fmtRate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 B/s"
  const kib = bps / 1024
  if (kib < 1) return `${bps.toFixed(0)} B/s`
  if (kib < 1024) return `${kib.toFixed(1)} KiB/s`
  return `${(kib / 1024).toFixed(2)} MiB/s`
}

export interface ForwardLiveCardProps {
  forward: PortForward
  // Compact mode shrinks paddings + hides the secondary metrics row; used
  // inside the workspace TcpForwardPanel where vertical space is scarce.
  compact?: boolean
}

export function ForwardLiveCard({ forward, compact = false }: ForwardLiveCardProps) {
  const qc = useQueryClient()
  const live = useForwardLive(forward.id)
  const bytesIn = live?.bytesIn ?? forward.bytes_in ?? 0
  const bytesOut = live?.bytesOut ?? forward.bytes_out ?? 0
  const inRate = live?.inRateBps ?? 0
  const outRate = live?.outRateBps ?? 0
  const activeConns = live?.activeConns ?? 0
  const history = live?.rateHistory ?? []
  const localAddr = `${forward.local_host}:${forward.local_port}`
  const targetAddr = `${forward.target_host}:${forward.target_port}`

  const close = useMutation({
    mutationFn: () => portfwdService.remove(forward.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["portfwd"] })
      toast.success("已释放")
    },
    onError: (e: { message?: string }) =>
      toast.error("释放失败", { description: e?.message }),
  })

  const copyAddr = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(localAddr)
      toast.success("已复制", { description: localAddr })
    } catch {
      toast.error("复制失败")
    }
  }, [localAddr])

  const openInBrowser = React.useCallback(() => {
    const scheme = forward.target_port === 443 ? "https" : "http"
    const url = `${scheme}://${localAddr}`
    window.open(url, "_blank", "noopener,noreferrer")
  }, [forward.target_port, localAddr])

  return (
    <Card className="overflow-hidden">
      <div className={compact ? "p-3 space-y-3" : "p-4 space-y-3"}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm font-medium truncate" title={localAddr}>
                {localAddr}
              </span>
              <Badge variant={STATUS_TONE[forward.status]}>{STATUS_LABEL[forward.status]}</Badge>
              {forward.pinned ? <Badge variant="outline">已固定</Badge> : null}
            </div>
            <div className="text-xs text-muted-foreground font-mono truncate" title={targetAddr}>
              → {targetAddr}
            </div>
            {forward.label ? (
              <div className="text-xs font-medium text-foreground truncate" title={forward.label}>
                {forward.label}
              </div>
            ) : null}
            {forward.tags && forward.tags.length > 0 ? (
              <div className="flex items-center gap-1 flex-wrap">
                {forward.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[10px] py-0">
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyAddr}>
                  <Copy className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>复制 {localAddr}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={openInBrowser}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>在浏览器打开</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={close.isPending}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: "释放该转发?",
                      description: `${localAddr} → ${targetAddr}`,
                    })
                    if (ok) close.mutate()
                  }}
                >
                  {close.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>关闭转发</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <Separator />

        <div className="grid grid-cols-2 gap-3 text-xs">
          <RateCell
            icon={<ArrowUp className="w-3 h-3" />}
            label="上行"
            rate={inRate}
            total={bytesIn}
          />
          <RateCell
            icon={<ArrowDown className="w-3 h-3" />}
            label="下行"
            rate={outRate}
            total={bytesOut}
          />
        </div>

        {!compact ? (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Activity className="w-3 h-3" />
              {activeConns} 活动连接
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {relTime(forward.expires_at)}
            </span>
          </div>
        ) : null}

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          <Sparkline
            data={history}
            color="hsl(var(--primary))"
            height={compact ? 32 : 44}
          />
        </motion.div>
      </div>
    </Card>
  )
}

function RateCell({
  icon,
  label,
  rate,
  total,
}: {
  icon: React.ReactNode
  label: string
  rate: number
  total: number
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase text-muted-foreground tracking-wider inline-flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="font-medium text-foreground">{fmtRate(rate)}</div>
      <div className="text-[10px] text-muted-foreground">累计 {fmtBytes(total)}</div>
    </div>
  )
}
