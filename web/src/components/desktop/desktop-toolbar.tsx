"use client"

import * as React from "react"
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
  return (
    <header
      className={cn(
        "h-10 shrink-0 flex items-center gap-1 px-2 isolate",
        "border-b border-border/60",
        "bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60",
      )}
    >
      <div className="flex items-center gap-1.5 mr-1.5 pl-1">
        <span className="relative inline-flex w-2 h-2 shrink-0">
          <span className={cn("absolute inset-0 rounded-full", STATUS_TINT[p.status])} />
          {showPulse && (
            <span className={cn("absolute inset-0 rounded-full animate-ping", STATUS_TINT[p.status])} />
          )}
        </span>
        <span className="text-[11px] text-muted-foreground">{STATUS_LABEL[p.status]}</span>
      </div>

      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-xs font-medium truncate max-w-[180px]">
          {p.nodeName || `node #${p.nodeId}`}
        </span>
        <Badge variant="outline" className="h-4 px-1.5 text-[10px] uppercase border-border/70 bg-muted/40">
          rdp · v2
        </Badge>
        {p.nodeHost && (
          <span className="text-[11px] text-muted-foreground font-mono truncate min-w-0">
            {p.nodeHost}
            {p.nodePort ? `:${p.nodePort}` : ""}
          </span>
        )}
        {p.remoteWidth > 0 && (
          <span className="text-[11px] text-muted-foreground/70 font-mono truncate min-w-0 hidden md:inline">
            · {p.remoteWidth}×{p.remoteHeight}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={p.onSendCtrlAltDel} className={btnCls()} aria-label="Ctrl+Alt+Del">
              <span className="text-[10px] font-mono">⌃⌥⌦</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">发送 Ctrl+Alt+Del(锁屏/任务管理)</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={btnCls()} aria-label="发送组合键" title="发送组合键">
              <Send className="w-3.5 h-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-xs">发送组合键</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {PRESET_COMBOS.map((c) => (
              <DropdownMenuItem
                key={c.combo}
                onSelect={() => p.onSendCombo(c.combo)}
                className="text-xs flex items-center gap-2"
              >
                <KeyboardIcon className="w-3.5 h-3.5" />
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

function btnCls(active?: boolean, variant?: "success" | "danger") {
  return cn(
    "inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors outline-none",
    "text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring",
    active && "bg-muted text-foreground",
    variant === "success" && "text-emerald-500 hover:text-emerald-400",
    variant === "danger" && "text-red-500 hover:text-red-400",
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
        <button onClick={onClick} aria-label={title} className={btnCls(active, variant)}>
          <Icon className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
}
