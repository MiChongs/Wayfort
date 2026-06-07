"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Clock,
  Command as CommandIcon,
  Gauge,
  HardDrive,
  Keyboard as KeyboardIcon,
  Maximize,
  Minimize,
  Monitor,
  Plug,
  RotateCw,
  Send,
  Settings as SettingsIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { DesktopStatus, SessionStats } from "./desktop-types"
import { formatClock, type LinkQuality } from "./desktop-connection"
import { SignalBars, LatencySparkline } from "./desktop-signal"
import { summarize, useDriveTransfers } from "./useDriveTransfers"
import { PRESET_COMBOS } from "./desktop-key-map"

type Props = {
  status: DesktopStatus
  nodeName?: string
  nodeId: number
  nodeHost?: string
  nodePort?: number
  remoteWidth: number
  remoteHeight: number
  fullscreen: boolean
  // Optional — backend label ("FreeRDP" / "IronRDP") and live link quality.
  backendLabel?: string
  quality?: LinkQuality
  // Live telemetry folded into the single control bar (was the old bottom
  // status bar). All optional so non-stat callers stay simple.
  stats?: SessionStats
  sessionMs?: number | null
  latencyHistory?: number[]
  keyboardLayout?: string
  onOpenPerfPanel?: () => void
  onSendCombo: (combo: string) => void
  onSendCtrlAltDel: () => void
  // onFiles is only wired for the freerdp backend (the per-user drive is
  // redirected by the worker). When absent the file button is hidden.
  onFiles?: () => void
  onSettings: () => void
  onPalette: () => void
  onFullscreen: () => void
  onReconnect: () => void
  onDisconnect: () => void
}

// Status pill styling — warm semantic tones from the design system instead of
// raw Tailwind colours. Transient phases pulse amber; connected settles to
// sage; failure is the destructive token; closed recedes to muted.
const STATUS_UI: Record<
  DesktopStatus,
  { label: string; text: string; bg: string; dot: string; pulse: boolean }
> = {
  "loading-script": { label: "加载中", text: "text-[#c08a2e] dark:text-[#e3b84e]", bg: "bg-[#d4a017]/12", dot: "bg-[#d4a017] dark:bg-[#e3b84e]", pulse: true },
  connecting: { label: "连接中", text: "text-[#c08a2e] dark:text-[#e3b84e]", bg: "bg-[#d4a017]/12", dot: "bg-[#d4a017] dark:bg-[#e3b84e]", pulse: true },
  handshake: { label: "握手中", text: "text-[#c08a2e] dark:text-[#e3b84e]", bg: "bg-[#d4a017]/12", dot: "bg-[#d4a017] dark:bg-[#e3b84e]", pulse: true },
  connected: { label: "已连接", text: "text-[#4c9b62] dark:text-[#5db872]", bg: "bg-[#5db872]/12", dot: "bg-[#5db872]", pulse: false },
  reconnecting: { label: "重连中", text: "text-[#c08a2e] dark:text-[#e3b84e]", bg: "bg-[#d4a017]/12", dot: "bg-[#d4a017] dark:bg-[#e3b84e]", pulse: true },
  closed: { label: "已断开", text: "text-muted-foreground", bg: "bg-muted", dot: "bg-muted-foreground", pulse: false },
  error: { label: "连接失败", text: "text-destructive", bg: "bg-destructive/10", dot: "bg-destructive", pulse: false },
}

export function DesktopToolbar(p: Props) {
  const reduce = useReducedMotion()
  const ui = STATUS_UI[p.status]
  const connected = p.status === "connected"
  return (
    <header
      className={cn(
        // The desktop viewer is a "dark product surface" (DESIGN.md): force the
        // dark token set on the bar so it renders as a warm-dark frosted chrome
        // over the remote content, regardless of the app's light/dark theme —
        // far more legible + premium than a pale strip washing over the desktop.
        "dark isolate flex h-10 shrink-0 items-center gap-2 px-2.5 text-foreground backdrop-blur-md transition-[border-radius,box-shadow]",
        p.fullscreen
          ? // Floating glass island over the fullscreen stage: rounded, ringed
            // and lifted with a soft shadow so it reads as a control surface
            // hovering above the remote desktop rather than a flat strip.
            "rounded-xl border border-white/10 bg-card/75 shadow-[0_14px_48px_-16px_rgba(0,0,0,0.75)] backdrop-blur-xl supports-[backdrop-filter]:bg-card/60"
          : // Flush top bar; a hairline + soft drop shadow separate it from the
            // remote content below.
            "border-b border-white/10 bg-card/80 shadow-[0_2px_12px_-6px_rgba(0,0,0,0.6)] supports-[backdrop-filter]:bg-card/65",
      )}
    >
      {/* Status pill */}
      <div className={cn("flex h-6 items-center gap-1.5 rounded-full pl-2 pr-2.5", ui.bg)}>
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className={cn("inline-block h-1.5 w-1.5 rounded-full", ui.dot)} />
          {ui.pulse && !reduce && (
            <span className={cn("absolute inset-0 animate-ping rounded-full", ui.dot)} />
          )}
        </span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={p.status}
            initial={reduce ? false : { opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 2 }}
            transition={{ duration: 0.12 }}
            className={cn("text-[11px] font-medium", ui.text)}
          >
            {ui.label}
          </motion.span>
        </AnimatePresence>
      </div>

      {/* Node identity */}
      <div className="flex min-w-0 items-center gap-2">
        <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="max-w-[180px] truncate text-[13px] font-medium text-foreground">
          {p.nodeName || `节点 #${p.nodeId}`}
        </span>
        {p.nodeHost && (
          <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">
            {p.nodeHost}
            {p.nodePort ? `:${p.nodePort}` : ""}
          </span>
        )}
        {p.remoteWidth > 0 && (
          <span className="hidden font-mono text-[11px] text-muted-foreground/60 lg:inline">
            {p.remoteWidth}×{p.remoteHeight}
          </span>
        )}
      </div>

      {/* Live link quality — only meaningful once connected */}
      {connected && p.quality && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-1 hidden items-center gap-1.5 text-muted-foreground sm:inline-flex">
              <SignalBars level={p.quality.level} tone={p.quality.tone} />
              <span className="text-[11px] text-muted-foreground/80">{p.quality.label}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">链路{p.quality.label}</TooltipContent>
        </Tooltip>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        {connected && (
          <>
            <StatsCluster
              stats={p.stats}
              sessionMs={p.sessionMs}
              latencyHistory={p.latencyHistory}
              quality={p.quality}
              keyboardLayout={p.keyboardLayout}
              onOpenPerfPanel={p.onOpenPerfPanel}
            />
            <Separator orientation="vertical" className="mx-1 hidden h-5 md:block" />
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={p.onSendCtrlAltDel}
              aria-label="Ctrl+Alt+Del"
            >
              <span className="font-mono text-[10px]">⌃⌥⌦</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">发送 Ctrl+Alt+Del(锁屏 / 任务管理器)</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="发送组合键"
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">发送组合键</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-xs">发送组合键</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {PRESET_COMBOS.map((c) => (
              <DropdownMenuItem
                key={c.combo}
                onSelect={() => p.onSendCombo(c.combo)}
                className="flex items-center gap-2 text-xs"
              >
                <KeyboardIcon className="h-3.5 w-3.5" />
                <span className="font-mono">{c.label}</span>
                {c.hint && <span className="ml-auto text-muted-foreground">{c.hint}</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator orientation="vertical" className="mx-1 h-5" />

        {p.onFiles && <DriveFileButton onClick={p.onFiles} />}
        <IconBtn icon={SettingsIcon} onClick={p.onSettings} title="桌面设置" />
        <IconBtn icon={CommandIcon} onClick={p.onPalette} title="命令面板 (Ctrl/⌘+Shift+P)" />
        <IconBtn
          icon={p.fullscreen ? Minimize : Maximize}
          onClick={p.onFullscreen}
          title={p.fullscreen ? "退出全屏 (F11)" : "全屏 (F11)"}
        />

        <Separator orientation="vertical" className="mx-1 h-5" />

        {p.status === "closed" || p.status === "error" ? (
          <IconBtn icon={RotateCw} onClick={p.onReconnect} title="重新连接" variant="success" />
        ) : (
          <IconBtn icon={Plug} onClick={p.onDisconnect} title="断开连接" variant="danger" />
        )}
      </div>
    </header>
  )
}

const TONE_TEXT: Record<LinkQuality["tone"], string> = {
  good: "text-[#4c9b62] dark:text-[#5db872]",
  fair: "text-[#c08a2e] dark:text-[#e3b84e]",
  poor: "text-destructive",
  muted: "text-muted-foreground",
}

// StatsCluster folds the old bottom status bar's live telemetry into the single
// control bar: session timer, latency (+ sparkline), fps, transport, keyboard
// and a perf-panel shortcut. Columns drop progressively on narrow widths so the
// action buttons always stay reachable. Lower-value metrics (pointer coords,
// byte counters) live in the perf panel now.
function StatsCluster({
  stats,
  sessionMs,
  latencyHistory,
  quality,
  keyboardLayout,
  onOpenPerfPanel,
}: {
  stats?: SessionStats
  sessionMs?: number | null
  latencyHistory?: number[]
  quality?: LinkQuality
  keyboardLayout?: string
  onOpenPerfPanel?: () => void
}) {
  const tone = quality?.tone ?? "muted"
  const latText = TONE_TEXT[tone]
  return (
    <div className="hidden items-center gap-2.5 pl-1 text-[11px] text-muted-foreground md:flex">
      {sessionMs != null && (
        <span className="inline-flex items-center gap-1 font-mono tabular-nums">
          <Clock className="h-3 w-3 text-muted-foreground/60" />
          {formatClock(sessionMs)}
        </span>
      )}
      <span className={cn("inline-flex items-center gap-1.5 font-mono tabular-nums", latText)}>
        {stats?.latencyMs == null ? "— ms" : `${stats.latencyMs} ms`}
        {latencyHistory && latencyHistory.length >= 2 && (
          <LatencySparkline points={latencyHistory} tone={tone} />
        )}
      </span>
      {stats?.fps != null && (
        <span className="hidden font-mono tabular-nums lg:inline">{stats.fps.toFixed(0)} fps</span>
      )}
      {stats?.transport && <span className="hidden text-foreground/65 xl:inline">{stats.transport}</span>}
      {keyboardLayout && (
        <span className="hidden font-mono uppercase text-muted-foreground/70 xl:inline">{keyboardLayout}</span>
      )}
      {onOpenPerfPanel && <IconBtn icon={Gauge} onClick={onOpenPerfPanel} title="性能监视 (Ctrl+Shift+P)" />}
    </div>
  )
}

function IconBtn({
  icon: Icon,
  onClick,
  title,
  variant,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
  variant?: "success" | "danger"
  active?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClick}
          aria-label={title}
          className={cn(
            "h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground",
            active && "bg-accent text-foreground",
            variant === "success" && "text-[#4c9b62] hover:bg-[#5db872]/12 hover:text-[#4c9b62] dark:text-[#5db872]",
            variant === "danger" && "text-destructive hover:bg-destructive/10 hover:text-destructive",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
}

// File-panel button with a live upload-progress ring. Subscribes to the drive
// transfer store on its own, so progress ticks re-render only this button — not
// the whole toolbar. The ring traces the byte-progress of the active batch.
function DriveFileButton({ onClick }: { onClick: () => void }) {
  const activeCount = useDriveTransfers((s) => summarize(s.transfers).activeCount)
  const pct = useDriveTransfers((s) => summarize(s.transfers).pct)
  const uploading = activeCount > 0
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClick}
          aria-label="文件传输 / 个人盘"
          className={cn(
            "relative h-7 w-7 text-muted-foreground hover:bg-accent hover:text-foreground",
            uploading && "text-primary",
          )}
        >
          <HardDrive className="h-3.5 w-3.5" />
          {uploading && (
            <svg className="pointer-events-none absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 28 28" aria-hidden>
              <circle cx="14" cy="14" r="12" fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={2} />
              <circle
                cx="14" cy="14" r="12" fill="none"
                stroke="currentColor" strokeWidth={2} strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 12}
                strokeDashoffset={2 * Math.PI * 12 * (1 - Math.min(100, pct) / 100)}
                style={{ transition: "stroke-dashoffset 200ms ease" }}
              />
            </svg>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {uploading ? `文件传输 · 上传中 ${pct}%` : "文件传输 / 个人盘"}
      </TooltipContent>
    </Tooltip>
  )
}
