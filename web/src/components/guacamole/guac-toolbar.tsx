"use client"

import * as React from "react"
import { motion, AnimatePresence } from "motion/react"
import {
  ArrowLeft,
  KeyRound,
  LogOut,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
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

export interface GuacToolbarProps {
  protocol: "rdp" | "vnc"
  nodeName?: string
  nodeHost?: string
  nodePort?: number
  phase: GuacPhase
  reconnectAttempts: number
  isFullscreen: boolean
  onSendCtrlAltDel(): void
  onReconnect(): void
  onDisconnect(): void
  onToggleFullscreen(): void
  backHref?: string
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

          <div className="ml-auto flex items-center gap-1">
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
                {props.isFullscreen ? "退出全屏 (Esc)" : "全屏 (F11)"}
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
