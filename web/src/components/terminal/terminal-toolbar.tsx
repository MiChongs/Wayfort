"use client"

import * as React from "react"
import Link from "next/link"
import {
  AArrowDown,
  AArrowUp,
  Bell,
  BellOff,
  Clipboard,
  Command as CommandIcon,
  Copy,
  Download,
  Eraser,
  FolderTree,
  Maximize,
  Minimize,
  Plug,
  RotateCw,
  Search as SearchIcon,
  Send,
  Settings as SettingsIcon,
  Zap,
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
import type { Status } from "./terminal-types"

type Props = {
  status: Status
  protocol: "ssh" | "telnet" | "dbcli"
  displayName?: string
  liveTitle: string
  subtitle: string
  nodeId: number
  fontSize: number
  bellEnabled: boolean
  searchActive: boolean
  fullscreen: boolean
  onCopy: () => void
  onPaste: () => void
  onClear: () => void
  onSendSignal: (ctrlChar: string) => void
  onToggleBell: () => void
  onExport: () => void
  onSearchToggle: () => void
  onSettings: () => void
  onPalette: () => void
  onFullscreen: () => void
  onFontDec: () => void
  onFontInc: () => void
  onFontReset: () => void
  onReconnect: () => void
  onDisconnect: () => void
  onOpenSftp?: () => void
  searchTrigger: React.RefObject<HTMLButtonElement | null>
}

export function TerminalToolbar(p: Props) {
  return (
    <header
      className={cn(
        "h-10 shrink-0 flex items-center gap-1 px-2 isolate",
        "border-b border-border/60",
        "bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60",
      )}
    >
      <StatusDot status={p.status} />
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-xs font-medium truncate max-w-[180px]">
          {p.displayName || `node #${p.nodeId}`}
        </span>
        <Badge
          variant="outline"
          className="h-4 px-1.5 text-[10px] uppercase border-border/70 bg-muted/40"
        >
          {p.protocol}
        </Badge>
        {p.subtitle && (
          <span className="text-[11px] text-muted-foreground font-mono truncate min-w-0">
            {p.subtitle}
          </span>
        )}
        {p.liveTitle && (
          <span className="text-[11px] text-muted-foreground/70 font-mono truncate min-w-0 hidden md:inline">
            · {p.liveTitle}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <IconBtn
          icon={SearchIcon}
          onClick={p.onSearchToggle}
          title="搜索 (Ctrl/⌘+Shift+F)"
          active={p.searchActive}
          ref={p.searchTrigger}
        />
        <IconBtn icon={Copy} onClick={p.onCopy} title="复制选区 (Ctrl/⌘+Shift+C)" />
        <IconBtn icon={Clipboard} onClick={p.onPaste} title="粘贴 (Ctrl/⌘+Shift+V)" />
        <IconBtn icon={Eraser} onClick={p.onClear} title="清屏" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={btnCls(false)} aria-label="发送控制信号" title="发送控制信号">
              <Send className="w-3.5 h-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs">发送控制字符</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => p.onSendSignal("\x03")} className="text-xs">
              <Zap className="w-3.5 h-3.5" />
              Ctrl+C — 中断 (SIGINT)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => p.onSendSignal("\x04")} className="text-xs">
              <Zap className="w-3.5 h-3.5" />
              Ctrl+D — EOF / 退出
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => p.onSendSignal("\x1a")} className="text-xs">
              <Zap className="w-3.5 h-3.5" />
              Ctrl+Z — 挂起 (SIGTSTP)
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => p.onSendSignal("\x0c")} className="text-xs">
              <Zap className="w-3.5 h-3.5" />
              Ctrl+L — 清屏
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <IconBtn
          icon={p.bellEnabled ? Bell : BellOff}
          onClick={p.onToggleBell}
          title={p.bellEnabled ? "关闭蜂鸣" : "启用蜂鸣"}
          active={p.bellEnabled}
        />
        <IconBtn icon={Download} onClick={p.onExport} title="导出当前会话为 .log" />

        {p.protocol === "ssh" &&
          (p.onOpenSftp ? (
            <IconBtn icon={FolderTree} onClick={p.onOpenSftp} title="在工作台打开 SFTP 文件管理" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={{ pathname: `/nodes/${p.nodeId}/sftp` }}
                  className={btnCls(false)}
                  aria-label="打开 SFTP 文件管理"
                >
                  <FolderTree className="w-3.5 h-3.5" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="bottom">打开 SFTP 文件管理</TooltipContent>
            </Tooltip>
          ))}

        <Separator orientation="vertical" className="mx-0.5 h-5" />

        <IconBtn icon={AArrowDown} onClick={p.onFontDec} title="字号 −" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={p.onFontReset}
              className="text-[11px] font-mono px-1.5 h-7 inline-flex items-center text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-md transition-colors"
              aria-label="重置字号"
            >
              {p.fontSize}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">点击重置字号</TooltipContent>
        </Tooltip>
        <IconBtn icon={AArrowUp} onClick={p.onFontInc} title="字号 +" />

        <Separator orientation="vertical" className="mx-0.5 h-5" />

        <IconBtn icon={SettingsIcon} onClick={p.onSettings} title="终端设置" />
        <IconBtn icon={CommandIcon} onClick={p.onPalette} title="命令面板 (Ctrl/⌘+Shift+P)" />
        <IconBtn
          icon={p.fullscreen ? Minimize : Maximize}
          onClick={p.onFullscreen}
          title={p.fullscreen ? "退出全屏 (F11)" : "全屏 (F11)"}
        />
        {p.status === "closed" ? (
          <IconBtn icon={RotateCw} onClick={p.onReconnect} title="重新连接" variant="success" />
        ) : (
          <IconBtn icon={Plug} onClick={p.onDisconnect} title="断开连接" variant="danger" />
        )}
      </div>
    </header>
  )
}

function StatusDot({ status }: { status: Status }) {
  const map: Record<Status, { dot: string; label: string }> = {
    connecting: { dot: "bg-amber-500", label: "连接中" },
    open: { dot: "bg-emerald-500", label: "已连接" },
    closed: { dot: "bg-red-500", label: "已断开" },
  }
  const s = map[status]
  return (
    <div className="flex items-center gap-1.5 mr-1.5 pl-1">
      <span className="relative inline-flex w-2 h-2 shrink-0">
        <span className={cn("absolute inset-0 rounded-full", s.dot)} />
        {status === "connecting" && (
          <span className={cn("absolute inset-0 rounded-full animate-ping", s.dot)} />
        )}
      </span>
      <span className="text-[11px] text-muted-foreground">{s.label}</span>
    </div>
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

const IconBtn = React.forwardRef<
  HTMLButtonElement,
  {
    icon: React.ComponentType<{ className?: string }>
    onClick: () => void
    title: string
    active?: boolean
    variant?: "success" | "danger"
  }
>(function IconBtn({ icon: Icon, onClick, title, active, variant }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button ref={ref} onClick={onClick} aria-label={title} className={btnCls(active, variant)}>
          <Icon className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
})
