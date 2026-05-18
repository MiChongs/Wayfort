"use client"

// RDPToolbar — Plan 15 toolbar. Built from scratch (rather than extending
// GuacToolbar) because the new feature set warrants a richer layout: an
// extra row of "advanced" toggles (recording / screenshot / annotation /
// stats / minimap / viewport-mode) alongside the original control row.

import * as React from "react"
import Link from "next/link"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowLeft,
  Activity,
  Camera,
  ChartArea,
  Circle,
  CircleDashed,
  Gauge,
  KeyRound,
  LogOut,
  Maximize2,
  Map as MapIcon,
  Minimize2,
  PencilLine,
  RefreshCw,
  Scan,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { GuacQuality } from "@/lib/ws/guacamole-client"
import type { RDPMetrics, RDPViewportMode, RDPViewportState } from "@/lib/rdp/types"
import type { GuacPhase } from "@/components/guacamole/guac-errors"
import { phaseLabel } from "@/components/guacamole/guac-errors"
import type { RecordingEvent } from "@/lib/rdp/plugins/recording"

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

const VIEWPORT_LABELS: Record<RDPViewportMode, string> = {
  fit: "适配",
  fill: "填充",
  actual: "原尺寸",
}

function formatBps(bps?: number) {
  if (bps == null) return "—"
  if (bps < 1024) return `${bps}B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)}KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)}MB/s`
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
}

export interface RDPToolbarProps {
  protocol: "rdp" | "vnc"
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  phase: GuacPhase
  reconnectAttempts: number
  isFullscreen: boolean
  quality: GuacQuality
  metrics?: RDPMetrics
  viewport?: RDPViewportState
  recording: RecordingEvent
  annotationOn: boolean
  statsOn: boolean
  minimapOn: boolean
  backHref?: string
  // controls
  onSendCtrlAltDel(): void
  onReconnect(): void
  onDisconnect(): void
  onToggleFullscreen(): void
  onQualityChange(q: GuacQuality): void
  onZoom(factor: number): void
  onSetViewportMode(m: RDPViewportMode): void
  onScreenshotDownload(): void
  onScreenshotCopy(): void
  onRecordingStart(): void
  onRecordingStop(): void
  onToggleAnnotation(): void
  onToggleStats(): void
  onToggleMinimap(): void
}

export function RDPToolbar(props: RDPToolbarProps) {
  // Auto-hide after 2.5s stillness, same UX as GuacToolbar.
  const [visible, setVisible] = React.useState(true)
  const hideTimer = React.useRef<number | null>(null)
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
  const showMetrics = props.phase === "connected"
  const recording = props.recording.state === "recording"
  const viewportMode: RDPViewportMode = props.viewport?.mode ?? "fit"

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: -64, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -64, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="absolute top-0 left-0 right-0 z-20 bg-background/80 backdrop-blur border-b border-border/60"
          onMouseEnter={() => setVisible(true)}
        >
          {/* Row 1: identity / status / metrics / primary actions */}
          <div className="px-3 py-2 flex items-center gap-2">
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
            {showMetrics && (
              <>
                <span className="ml-2 text-[11px] font-mono text-muted-foreground flex items-center gap-1">
                  <Activity className="w-3 h-3" />
                  {props.metrics?.fps ? `${props.metrics.fps.toFixed(0)} fps` : "—"}
                </span>
                <span className="text-[11px] font-mono text-muted-foreground">
                  ↓ {formatBps(props.metrics?.bytesPerSecIn)}
                </span>
              </>
            )}
            <div className="ml-auto flex items-center gap-1">
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
              <ToolbarBtn
                title="重新连接"
                onClick={props.onReconnect}
                icon={RefreshCw}
              />
              <ToolbarBtn
                title={props.isFullscreen ? "退出全屏 (Esc)" : "全屏 (F11)"}
                onClick={props.onToggleFullscreen}
                icon={props.isFullscreen ? Minimize2 : Maximize2}
              />
              <ToolbarBtn
                title="断开连接"
                onClick={props.onDisconnect}
                icon={LogOut}
                danger
              />
            </div>
          </div>
          {/* Row 2: advanced feature toggles */}
          <div className="px-3 pb-2 flex items-center gap-1">
            <ToolbarBtn
              title={recording ? `录制中 ${formatDuration(props.recording.durationMs)}` : "开始录制"}
              onClick={recording ? props.onRecordingStop : props.onRecordingStart}
              icon={recording ? Circle : CircleDashed}
              active={recording}
              danger={recording}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="截图"
                >
                  <Camera className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="text-xs">
                <DropdownMenuItem onClick={props.onScreenshotDownload}>
                  下载 PNG
                </DropdownMenuItem>
                <DropdownMenuItem onClick={props.onScreenshotCopy}>
                  复制到剪贴板
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ToolbarBtn
              title="标注（笔/箭头/矩形）"
              onClick={props.onToggleAnnotation}
              icon={PencilLine}
              active={props.annotationOn}
            />
            <ToolbarBtn
              title="性能统计 (FPS / MS / Heap)"
              onClick={props.onToggleStats}
              icon={ChartArea}
              active={props.statsOn}
            />
            <ToolbarBtn
              title="小地图"
              onClick={props.onToggleMinimap}
              icon={MapIcon}
              active={props.minimapOn}
            />
            <div className="ml-3 flex items-center gap-0.5">
              <ToolbarBtn
                title="缩小"
                onClick={() => props.onZoom(1 / 1.15)}
                icon={ZoomOut}
              />
              <ToolbarBtn
                title="放大"
                onClick={() => props.onZoom(1.15)}
                icon={ZoomIn}
              />
              <Select
                value={viewportMode}
                onValueChange={(v) => props.onSetViewportMode(v as RDPViewportMode)}
              >
                <SelectTrigger className="h-7 px-2 gap-1 text-[11px] w-auto min-w-0 border-border/60">
                  <Scan className="w-3.5 h-3.5" />
                  <SelectValue placeholder="模式" />
                </SelectTrigger>
                <SelectContent>
                  {(["fit", "fill", "actual"] as RDPViewportMode[]).map((m) => (
                    <SelectItem key={m} value={m} className="text-xs">
                      {VIEWPORT_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {props.viewport && (
                <span className="ml-2 text-[10px] font-mono text-muted-foreground tabular-nums">
                  {Math.round(props.viewport.scale * 100)}%
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {showMetrics && (
                <>
                  <span>指令 {props.metrics?.instructionsPerSec ?? "—"}/s</span>
                  {props.metrics?.lastSyncAgeMs != null && (
                    <span>
                      sync {props.metrics.lastSyncAgeMs}ms
                    </span>
                  )}
                  {props.metrics?.jsHeapMb != null && (
                    <span>{props.metrics.jsHeapMb}MB</span>
                  )}
                </>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ToolbarBtn({
  title,
  onClick,
  icon: Icon,
  active,
  danger,
}: {
  title: string
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  active?: boolean
  danger?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={active ? "secondary" : "ghost"}
          size="icon"
          className={cn(
            "h-7 w-7",
            danger && "text-destructive hover:text-destructive",
          )}
          onClick={onClick}
          aria-label={title}
        >
          <Icon className="w-3.5 h-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
}

// Silence the unused-import linter for `Square` which we reserve for future
// "stop recording" alt UI.
export { Square }
