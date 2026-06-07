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
  History,
  Maximize,
  Minimize,
  MoreHorizontal,
  Plug,
  RotateCw,
  Search as SearchIcon,
  Settings as SettingsIcon,
  TerminalSquare,
  Zap,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { SignalBars } from "@/components/desktop/desktop-signal"
import type { LinkQuality } from "@/components/desktop/desktop-connection"
import type { Status } from "./terminal-types"

type Props = {
  status: Status
  protocol: "ssh" | "telnet" | "dbcli"
  displayName?: string
  liveTitle: string
  subtitle: string
  nodeId: number
  quality?: LinkQuality
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
  // Phase 11 — optional snippet + history launchers.
  onOpenSnippets?: () => void
  onOpenHistory?: () => void
  searchTrigger: React.RefObject<HTMLButtonElement | null>
}

// Toolbar layout: identity on the left (status pill + name + protocol + link
// quality), the four highest-frequency actions on the right, and everything
// else folded into a single "⋯ more" menu. The dense 15-button strip was the
// main source of the cramped, mechanical feel; collapsing the long tail keeps
// the bar legible and overflow-safe at any panel width.
export function TerminalToolbar(p: Props) {
  const connected = p.status === "open"
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
          className="h-4 shrink-0 px-1.5 text-[10px] uppercase border-border/70 bg-muted/40"
        >
          {p.protocol}
        </Badge>
        {p.subtitle && (
          <span className="hidden text-[11px] text-muted-foreground font-mono truncate min-w-0 sm:inline">
            {p.subtitle}
          </span>
        )}
        {p.liveTitle && (
          <span className="text-[11px] text-muted-foreground/70 font-mono truncate min-w-0 hidden lg:inline">
            · {p.liveTitle}
          </span>
        )}
      </div>

      {connected && p.quality && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-1 hidden items-center gap-1.5 text-muted-foreground md:inline-flex">
              <SignalBars level={p.quality.level} tone={p.quality.tone} />
              <span className="text-[11px] text-muted-foreground/80">{p.quality.label}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">链路{p.quality.label}</TooltipContent>
        </Tooltip>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {/* Primary actions — always visible (copy/paste fold away on very narrow panels). */}
        <IconBtn
          icon={SearchIcon}
          onClick={p.onSearchToggle}
          title="搜索 (Ctrl/⌘+Shift+F)"
          active={p.searchActive}
          ref={p.searchTrigger}
        />
        <IconBtn icon={Copy} onClick={p.onCopy} title="复制选区 (Ctrl/⌘+Shift+C)" className="hidden sm:inline-flex" />
        <IconBtn icon={Clipboard} onClick={p.onPaste} title="粘贴 (Ctrl/⌘+Shift+V)" className="hidden sm:inline-flex" />

        {/* Overflow — the long tail of less-frequent controls. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="更多操作"
              title="更多操作"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={p.onCopy} className="text-xs sm:hidden">
              <Copy className="h-3.5 w-3.5" /> 复制选区
              <DropdownMenuShortcut>⇧C</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={p.onPaste} className="text-xs sm:hidden">
              <Clipboard className="h-3.5 w-3.5" /> 粘贴
              <DropdownMenuShortcut>⇧V</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="sm:hidden" />

            <DropdownMenuItem onSelect={p.onClear} className="text-xs">
              <Eraser className="h-3.5 w-3.5" /> 清屏
            </DropdownMenuItem>
            {p.onOpenSnippets && (
              <DropdownMenuItem onSelect={p.onOpenSnippets} className="text-xs">
                <TerminalSquare className="h-3.5 w-3.5" /> 命令片段
                <DropdownMenuShortcut>⇧I</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {p.onOpenHistory && (
              <DropdownMenuItem onSelect={p.onOpenHistory} className="text-xs">
                <History className="h-3.5 w-3.5" /> 命令历史
                <DropdownMenuShortcut>⇧H</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />
            {/* Font size — kept open while the user nudges it. */}
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-xs text-muted-foreground">字号</span>
              <div className="flex items-center gap-0.5">
                <MenuStepBtn icon={AArrowDown} onClick={p.onFontDec} title="字号 −" />
                <button
                  type="button"
                  onClick={p.onFontReset}
                  title="点击重置字号"
                  className="h-6 w-7 rounded font-mono text-[11px] text-foreground/80 hover:bg-muted"
                >
                  {p.fontSize}
                </button>
                <MenuStepBtn icon={AArrowUp} onClick={p.onFontInc} title="字号 +" />
              </div>
            </div>

            <DropdownMenuItem onSelect={p.onToggleBell} className="text-xs">
              {p.bellEnabled ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
              {p.bellEnabled ? "关闭蜂鸣" : "启用蜂鸣"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={p.onExport} className="text-xs">
              <Download className="h-3.5 w-3.5" /> 导出会话日志
            </DropdownMenuItem>
            {p.protocol === "ssh" &&
              (p.onOpenSftp ? (
                <DropdownMenuItem onSelect={p.onOpenSftp} className="text-xs">
                  <FolderTree className="h-3.5 w-3.5" /> SFTP 文件管理
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem asChild className="text-xs">
                  <Link href={{ pathname: `/nodes/${p.nodeId}/sftp` }}>
                    <FolderTree className="h-3.5 w-3.5" /> SFTP 文件管理
                  </Link>
                </DropdownMenuItem>
              ))}

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Zap className="h-3 w-3" /> 发送控制字符
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => p.onSendSignal("\x03")} className="text-xs">
              中断 <DropdownMenuShortcut>Ctrl C</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => p.onSendSignal("\x04")} className="text-xs">
              EOF / 退出 <DropdownMenuShortcut>Ctrl D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => p.onSendSignal("\x1a")} className="text-xs">
              挂起 <DropdownMenuShortcut>Ctrl Z</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => p.onSendSignal("\x0c")} className="text-xs">
              清屏 <DropdownMenuShortcut>Ctrl L</DropdownMenuShortcut>
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={p.onSettings} className="text-xs">
              <SettingsIcon className="h-3.5 w-3.5" /> 终端设置
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={p.onPalette} className="text-xs">
              <CommandIcon className="h-3.5 w-3.5" /> 命令面板
              <DropdownMenuShortcut>⇧P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={p.onFullscreen} className="text-xs">
              {p.fullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
              {p.fullscreen ? "退出全屏" : "全屏"}
              <DropdownMenuShortcut>F11</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator orientation="vertical" className="mx-0.5 h-5" />

        {p.status === "closed" || p.status === "error" ? (
          <IconBtn icon={RotateCw} onClick={p.onReconnect} title="重新连接" variant="success" />
        ) : (
          <IconBtn icon={Plug} onClick={p.onDisconnect} title="断开连接" variant="danger" />
        )}
      </div>
    </header>
  )
}

// Warm status pill — design-system tones (amber transient · sage connected ·
// destructive error · muted closed) instead of raw emerald/red.
const STATUS_UI: Record<
  Status,
  { label: string; text: string; bg: string; dot: string; pulse: boolean }
> = {
  connecting: { label: "连接中", text: "text-[#c08a2e] dark:text-[#e3b84e]", bg: "bg-[#d4a017]/12", dot: "bg-[#d4a017] dark:bg-[#e3b84e]", pulse: true },
  reconnecting: { label: "重连中", text: "text-[#c08a2e] dark:text-[#e3b84e]", bg: "bg-[#d4a017]/12", dot: "bg-[#d4a017] dark:bg-[#e3b84e]", pulse: true },
  open: { label: "已连接", text: "text-[#4c9b62] dark:text-[#5db872]", bg: "bg-[#5db872]/12", dot: "bg-[#5db872]", pulse: false },
  closed: { label: "已断开", text: "text-muted-foreground", bg: "bg-muted", dot: "bg-muted-foreground", pulse: false },
  error: { label: "连接失败", text: "text-destructive", bg: "bg-destructive/10", dot: "bg-destructive", pulse: false },
}

function StatusDot({ status }: { status: Status }) {
  const ui = STATUS_UI[status]
  return (
    <div className={cn("mr-0.5 flex h-6 shrink-0 items-center gap-1.5 rounded-full pl-2 pr-2.5", ui.bg)}>
      <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", ui.dot)} />
        {ui.pulse && <span className={cn("absolute inset-0 animate-ping rounded-full", ui.dot)} />}
      </span>
      <span className={cn("text-[11px] font-medium", ui.text)}>{ui.label}</span>
    </div>
  )
}

// Small +/- stepper used inside the font-size menu row. Plain button (not a
// menu item) so clicking it does not close the dropdown.
function MenuStepBtn({
  icon: Icon,
  onClick,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      title={title}
      className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
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
    className?: string
  }
>(function IconBtn({ icon: Icon, onClick, title, active, variant, className }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          size="icon"
          variant="ghost"
          onClick={onClick}
          aria-label={title}
          className={cn(
            "h-7 w-7 text-muted-foreground hover:text-foreground",
            active && "bg-muted text-foreground",
            variant === "success" && "text-[#4c9b62] hover:text-[#4c9b62] dark:text-[#5db872]",
            variant === "danger" && "text-destructive hover:text-destructive",
            className,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
})
