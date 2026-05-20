"use client"

// Phase 10 — desktop loading / error overlay. Card-style shell, motion
// transitions between connect-states, shadcn primitives only. The phase steps
// are now a real visual list with a Progress bar at the top so operators get
// a sense of "how far did we get before this stalled".

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RotateCw,
  ShieldCheck,
  ShieldOff,
  Wifi,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { DesktopStatus } from "./desktop-types"

// 0x0002000D = ERRCONNECT_CONNECT_TRANSPORT_FAILED — surfaced when TLS/NLA
// handshake times out. Showing a "force TLS-only retry" shortcut for that
// specific code lets the operator unblock connections to NLA-disabled
// servers without bouncing through the admin/nodes editor.
const ERR_TRANSPORT_FAILED = 0x0002000d

type Props = {
  status: DesktopStatus
  errorMessage?: string
  errorCode?: number
  elapsedMs: number
  nodeName?: string
  onRetry: () => void
  onForceTlsOnly?: () => void
  onSwitchToGuacamole?: () => void
}

const PHASE_LABEL: Partial<Record<DesktopStatus, string>> = {
  "loading-script": "初始化渲染器",
  connecting: "建立 WebSocket 通道",
  handshake: "协商 RDP 安全层",
  reconnecting: "网络中断,重连中",
  closed: "会话已结束",
}

// Visual progress percentage per phase — gives the user a sense of
// progression even before any real data lands.
const PHASE_PROGRESS: Partial<Record<DesktopStatus, number>> = {
  "loading-script": 20,
  connecting: 45,
  handshake: 75,
  reconnecting: 35,
  connected: 100,
  closed: 0,
  error: 0,
}

export function DesktopLoadingOverlay({
  status,
  errorMessage,
  errorCode,
  elapsedMs,
  nodeName,
  onRetry,
  onForceTlsOnly,
  onSwitchToGuacamole,
}: Props) {
  const reducedMotion = useReducedMotion()
  if (status === "connected") return null
  const isError = status === "error"
  const seconds = (elapsedMs / 1000).toFixed(1)

  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={isError ? "error" : "loading"}
          initial={reducedMotion ? false : { opacity: 0, scale: 0.97, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reducedMotion ? undefined : { opacity: 0, scale: 0.97, y: -6 }}
          transition={{ type: "spring", stiffness: 360, damping: 28 }}
          className="w-full max-w-md"
        >
          <Card className="shadow-xl">
            <CardContent className="space-y-4 p-6">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border",
                    isError
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-primary/30 bg-primary/10 text-primary",
                  )}
                >
                  {isError ? (
                    <AlertCircle className="h-4 w-4" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold">
                    {isError ? "连接失败" : `正在连接到 ${nodeName || "远端桌面"}`}
                  </h3>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.p
                      key={status}
                      initial={reducedMotion ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reducedMotion ? undefined : { opacity: 0, y: 4 }}
                      transition={{ duration: 0.15 }}
                      className="mt-0.5 text-xs text-muted-foreground"
                    >
                      {isError ? errorMessage || "" : `${PHASE_LABEL[status] || "连接中"} · 已用时 ${seconds}s`}
                    </motion.p>
                  </AnimatePresence>
                </div>
                {!isError && (
                  <Badge variant="outline" className="font-mono text-[10px] font-normal">
                    <Wifi className="mr-1 h-3 w-3" />
                    {status}
                  </Badge>
                )}
              </div>

              {!isError && (
                <Progress
                  value={PHASE_PROGRESS[status] ?? 0}
                  indicatorClassName={status === "reconnecting" ? "bg-amber-500" : undefined}
                />
              )}

              {isError && errorMessage && (
                <Alert variant="destructive" className="text-xs">
                  <AlertTitle className="text-xs">{errorMessage}</AlertTitle>
                  {errorCode != null && errorCode !== 0 && (
                    <AlertDescription className="font-mono text-[10px]">
                      错误码 0x{errorCode.toString(16).padStart(8, "0").toUpperCase()}
                    </AlertDescription>
                  )}
                </Alert>
              )}

              {!isError && (
                <div className="space-y-1">
                  <PhaseStep
                    label="加载渲染器"
                    done={status !== "loading-script"}
                  />
                  <PhaseStep
                    label="建立 WebSocket"
                    done={status === "handshake" || status === "closed"}
                    active={status === "connecting" || status === "reconnecting"}
                  />
                  <PhaseStep label="协商 RDP 安全层" done={false} active={status === "handshake"} />
                </div>
              )}

              {isError && (
                <div className="flex flex-wrap justify-end gap-2 pt-1">
                  {onSwitchToGuacamole && (
                    <Button size="sm" variant="secondary" onClick={onSwitchToGuacamole}>
                      <ShieldCheck className="h-3.5 w-3.5" /> 切换经典 RDP
                    </Button>
                  )}
                  {errorCode === ERR_TRANSPORT_FAILED && onForceTlsOnly && (
                    <Button size="sm" variant="outline" onClick={onForceTlsOnly}>
                      <ShieldOff className="h-3.5 w-3.5" /> 禁用 NLA 重试
                    </Button>
                  )}
                  <Button size="sm" onClick={onRetry}>
                    <RotateCw className="h-3.5 w-3.5" /> 重试
                  </Button>
                </div>
              )}
              {isError && onSwitchToGuacamole && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  新栈 FreeRDP 在 Windows 11/Server 2022 等场景偶有兼容性问题。
                  点 <span className="font-medium text-foreground">切换经典 RDP</span>{" "}
                  会用同一凭据通过 Guacamole 通道重连,通常更稳。
                </p>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function PhaseStep({ label, done, active }: { label: string; done: boolean; active?: boolean }) {
  return (
    <motion.div
      layout
      className="flex items-center gap-2 text-xs"
    >
      {done ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
      ) : (
        <span
          className={cn(
            "inline-block h-2 w-2 shrink-0 rounded-full",
            active ? "animate-pulse bg-amber-500" : "bg-muted",
          )}
        />
      )}
      <span
        className={cn(
          done
            ? "text-foreground"
            : active
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </motion.div>
  )
}
