"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Command as CommandIcon,
  Keyboard as KeyboardIcon,
  Maximize,
  Minimize,
  Plug,
  RotateCw,
  Send,
  Settings as SettingsIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
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
import type { DesktopStatus } from "./desktop-types"
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
  onSendCombo: (combo: string) => void
  onSendCtrlAltDel: () => void
  onSettings: () => void
  onPalette: () => void
  onFullscreen: () => void
  onReconnect: () => void
  onDisconnect: () => void
}

// Status palette — single source of truth for both the toolbar pulse dot and
// any other element (status bar, perf panel) that wants to mirror the badge.
const STATUS_TINT: Record<DesktopStatus, string> = {
  "loading-script": "bg-amber-500",
  connecting: "bg-amber-500",
  handshake: "bg-amber-500",
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-500",
  closed: "bg-zinc-500",
  error: "bg-red-500",
}

const STATUS_LABEL: Record<DesktopStatus, string> = {
  "loading-script": "加载中",
  connecting: "连接中",
  handshake: "握手中",
  connected: "已连接",
  reconnecting: "重连中",
  closed: "已断开",
  error: "错误",
}

export function DesktopToolbar(p: Props) {
  const showPulse = p.status !== "connected" && p.status !== "closed" && p.status !== "error"
  const reducedMotion = useReducedMotion()
  return (
    <header
      className={cn(
        "isolate flex h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-card/80 px-2 backdrop-blur supports-[backdrop-filter]:bg-card/60",
      )}
    >
      <div className="mr-1.5 flex items-center gap-1.5 pl-1">
        <span className="relative inline-flex h-2 w-2 shrink-0">
          <motion.span
            layout
            transition={{ type: "spring", stiffness: 360, damping: 24 }}
            className={cn("absolute inset-0 rounded-full", STATUS_TINT[p.status])}
          />
          {showPulse && !reducedMotion && (
            <span className={cn("absolute inset-0 animate-ping rounded-full", STATUS_TINT[p.status])} />
          )}
        </span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={p.status}
            initial={reducedMotion ? false : { opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? undefined : { opacity: 0, y: 2 }}
            transition={{ duration: 0.12 }}
            className="text-[11px] text-muted-foreground"
          >
            {STATUS_LABEL[p.status]}
          </motion.span>
        </AnimatePresence>
      </div>

      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="max-w-[180px] truncate text-xs font-medium">
          {p.nodeName || `node #${p.nodeId}`}
        </span>
        <Badge variant="outline" className="h-4 border-border/70 bg-muted/40 px-1.5 text-[10px] uppercase">
          rdp · v2
        </Badge>
        {p.nodeHost && (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {p.nodeHost}
            {p.nodePort ? `:${p.nodePort}` : ""}
          </span>
        )}
        {p.remoteWidth > 0 && (
          <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground/70 md:inline">
            · {p.remoteWidth}×{p.remoteHeight}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={p.onSendCtrlAltDel}
              aria-label="Ctrl+Alt+Del"
            >
              <span className="font-mono text-[10px]">⌃⌥⌦</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">发送 Ctrl+Alt+Del(锁屏/任务管理)</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
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

        <Separator orientation="vertical" className="mx-0.5 h-5" />

        <IconBtn icon={SettingsIcon} onClick={p.onSettings} title="桌面设置" />
        <IconBtn icon={CommandIcon} onClick={p.onPalette} title="命令面板 (Ctrl/⌘+Shift+P)" />
        <IconBtn
          icon={p.fullscreen ? Minimize : Maximize}
          onClick={p.onFullscreen}
          title={p.fullscreen ? "退出全屏 (F11)" : "全屏 (F11)"}
        />
        {p.status === "closed" || p.status === "error" ? (
          <IconBtn icon={RotateCw} onClick={p.onReconnect} title="重新连接" variant="success" />
        ) : (
          <IconBtn icon={Plug} onClick={p.onDisconnect} title="断开连接" variant="danger" />
        )}
      </div>
    </header>
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
            "h-7 w-7 text-muted-foreground hover:text-foreground",
            active && "bg-muted text-foreground",
            variant === "success" && "text-emerald-500 hover:text-emerald-400",
            variant === "danger" && "text-red-500 hover:text-red-400",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
}
