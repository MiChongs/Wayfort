"use client"

import * as React from "react"
import { motion, AnimatePresence } from "motion/react"
import {
  ArrowLeft,
  Activity,
  Gauge,
  KeyRound,
  LogOut,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { GuacMetrics, GuacQuality } from "@/lib/ws/guacamole-client"
import type { GuacPhase } from "./guac-errors"
import { phaseLabel } from "./guac-errors"

const PHASE_TONE: Record<GuacPhase, { dot: string; text: string }> = {
  idle: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
  "loading-script": { dot: "bg-sky-500 animate-pulse", text: "text-sky-700 dark:text-sky-300" },
  connecting: { dot: "bg-sky-500 animate-pulse", text: "text-sky-700 dark:text-sky-300" },
  handshake: { dot: "bg-amber-500 animate-pulse", text: "text-amber-700 dark:text-amber-300" },
  connected: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
  disconnecting: { dot: "bg-muted-foreground animate-pulse", text: "text-muted-foreground" },
  disconnected: { dot: "bg-zinc-500", text: "text-zinc-400" },
  error: { dot: "bg-destructive", text: "text-destructive" },
}

const QUALITY_LABELS: Record<GuacQuality, string> = {
  auto: "自动",
  high: "高 (32-bit + 壁纸)",
  medium: "中 (24-bit)",
  low: "低 (16-bit, 省带宽)",
}

export interface GuacToolbarProps {
  protocol: "rdp" | "vnc"
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  phase: GuacPhase
  reconnectAttempts: number
  isFullscreen: boolean
  // Plan 13.D.1 — performance preset.
  quality: GuacQuality
  // Plan 13.D.2/D.3 — periodic metrics for latency + bandwidth indicators.
  metrics?: GuacMetrics
  onSendCtrlAltDel(): void
  onReconnect(): void
  onDisconnect(): void
  onToggleFullscreen(): void
  onQualityChange(q: GuacQuality): void
  backHref?: string
}

// Plan 13.D.2 — latency proxy: time since last sync from guacd. Green <800ms
// (responsive), amber 800-2000ms (sluggish), red >2000ms (degraded).
function latencyTone(ageMs?: number) {
  if (ageMs == null) return { color: "text-muted-foreground", label: "—" }
  if (ageMs < 800) return { color: "text-emerald-500", label: `${ageMs}ms` }
  if (ageMs < 2000) return { color: "text-amber-500", label: `${ageMs}ms` }
  return { color: "text-destructive", label: `${(ageMs / 1000).toFixed(1)}s` }
}

// Plan 13.D.3 — format inbound bandwidth as human-readable per-second rate.
function formatBps(bps?: number) {
  if (bps == null) return "—"
  if (bps < 1024) return `${bps}B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)}KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)}MB/s`
}

export function GuacToolbar(props: GuacToolbarProps) {
  const [visible, setVisible] = React.useState(true)
  const hideTimer = React.useRef<number | null>(null)

  // Auto-hide after 2.5s of mouse stillness; reappear on mouse enter top
  // strip (handled by parent positioning the wrapper).
  React.useEffect(() => {
    function reschedule() {
      setVisible(true)
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current)
      hideTimer.current = window.setTimeout(() => setVisible(false), 2500)
    }
    reschedule()
    window.addEventListener("mousemove", reschedule)
    return () => {
      window.removeEventListener("mousemove", reschedule)
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current)
    }
  }, [])

  const tone = PHASE_TONE[props.phase]
  const phaseTxt = phaseLabel(props.phase)
  const lat = latencyTone(props.metrics?.lastSyncAgeMs)
  const showMetrics = props.phase === "connected"

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: -56, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -56, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="absolute top-0 left-0 right-0 z-20 px-3 py-2 flex items-center gap-2 bg-background/80 backdrop-blur border-b border-border/60"
          onMouseEnter={() => setVisible(true)}
        >
          {props.backHref && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon" className="h-7 w-7">
                  <Link href={props.backHref as Parameters<typeof Link>[0]["href"]}>
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">返回节点详情</TooltipContent>
            </Tooltip>
          )}
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">
              {props.nodeName || `node #${props.protocol}`}
            </span>
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 uppercase">
              {props.protocol}
            </Badge>
            {props.nodeHost && (
              <span className="text-[11px] font-mono text-muted-foreground truncate">
                {props.nodeHost}:{props.nodePort}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 ml-2">
            <span className={cn("inline-block w-1.5 h-1.5 rounded-full", tone.dot)} />
            <span className={cn("text-[11px]", tone.text)}>
              {phaseTxt}
              {props.reconnectAttempts > 0 && props.phase !== "connected" && (
                <span className="ml-1 opacity-70">(重连 {props.reconnectAttempts}/3)</span>
              )}
            </span>
          </div>

          {/* Plan 13.D.2/D.3 — live metrics, only meaningful while connected. */}
          {showMetrics && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-2 flex items-center gap-1 text-[11px] font-mono">
                    <Activity className={cn("w-3 h-3", lat.color)} />
                    <span className={lat.color}>{lat.label}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  距上次同步 — 服务器响应延迟代理
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground">
                    <span>↓ {formatBps(props.metrics?.bytesPerSecIn)}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">下行带宽</TooltipContent>
              </Tooltip>
            </>
          )}

          <div className="ml-auto flex items-center gap-1">
            {/* Plan 13.D.1 — quality preset selector. Triggers a clean
                reconnect so the new color depth / wallpaper params take effect. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Select
                    value={props.quality}
                    onValueChange={(v) => props.onQualityChange(v as GuacQuality)}
                  >
                    <SelectTrigger className="h-7 px-2 gap-1 text-[11px] w-auto min-w-0 border-border/60">
                      <Gauge className="w-3.5 h-3.5" />
                      <SelectValue placeholder="质量" />
                    </SelectTrigger>
                    <SelectContent>
                      {(["auto", "high", "medium", "low"] as GuacQuality[]).map((q) => (
                        <SelectItem key={q} value={q} className="text-xs">
                          {QUALITY_LABELS[q]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                画质 / 带宽预设（切换会重新连接）
              </TooltipContent>
            </Tooltip>

            {props.protocol === "rdp" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 gap-1"
                    onClick={props.onSendCtrlAltDel}
                    disabled={props.phase !== "connected"}
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span className="text-[11px]">Ctrl-Alt-Del</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">向远端发送 Ctrl + Alt + Del</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={props.onReconnect}
                  aria-label="重新连接"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">重新连接</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={props.onToggleFullscreen}
                  aria-label="全屏"
                >
                  {props.isFullscreen ? (
                    <Minimize2 className="w-3.5 h-3.5" />
                  ) : (
                    <Maximize2 className="w-3.5 h-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {props.isFullscreen ? "退出全屏 (Esc)" : "全屏 (F11，自动启用键盘锁定)"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={props.onDisconnect}
                  aria-label="断开连接"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">断开连接</TooltipContent>
            </Tooltip>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
