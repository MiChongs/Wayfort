"use client"

import * as React from "react"
import { AlertCircle, Loader2, RotateCw, ShieldOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
  // Optional. When provided AND the error code matches ERRCONNECT_*_FAILED,
  // the overlay shows a "禁用 NLA 重试" button that the parent wires to a
  // node.proto_options PATCH + reconnect.
  onForceTlsOnly?: () => void
}

const PHASE_LABEL: Partial<Record<DesktopStatus, string>> = {
  "loading-script": "初始化渲染器",
  connecting: "建立 WebSocket 通道",
  handshake: "协商 RDP 安全层",
  reconnecting: "网络中断,重连中",
  closed: "会话已结束",
}

export function DesktopLoadingOverlay({
  status,
  errorMessage,
  errorCode,
  elapsedMs,
  nodeName,
  onRetry,
  onForceTlsOnly,
}: Props) {
  if (status === "connected") return null
  const isError = status === "error"
  const seconds = (elapsedMs / 1000).toFixed(1)

  return (
    <div
      className={cn(
        "absolute inset-0 z-10 flex items-center justify-center p-4",
        "bg-background/70 backdrop-blur-sm",
      )}
      role="status"
      aria-live="polite"
    >
      <div className="w-full max-w-md rounded-lg border bg-card shadow-lg p-6 space-y-4">
        <div className="flex items-center gap-3">
          {isError ? (
            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
          ) : (
            <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">
              {isError ? "连接失败" : `正在连接到 ${nodeName || "远端桌面"}`}
            </h3>
            {!isError && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {PHASE_LABEL[status] || "连接中"} · 已用时 {seconds}s
              </p>
            )}
          </div>
        </div>

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
            <PhaseStep label="加载渲染器" done={status !== "loading-script"} />
            <PhaseStep
              label="建立 WebSocket"
              done={status === "handshake" || status === "closed"}
              active={status === "connecting" || status === "reconnecting"}
            />
            <PhaseStep label="协商 RDP 安全层" done={false} active={status === "handshake"} />
          </div>
        )}

        {isError && (
          <div className="flex justify-end gap-2 pt-1">
            {errorCode === ERR_TRANSPORT_FAILED && onForceTlsOnly && (
              <Button size="sm" variant="outline" onClick={onForceTlsOnly}>
                <ShieldOff className="w-3.5 h-3.5" /> 禁用 NLA 重试
              </Button>
            )}
            <Button size="sm" onClick={onRetry}>
              <RotateCw className="w-3.5 h-3.5" /> 重试
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function PhaseStep({ label, done, active }: { label: string; done: boolean; active?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={cn(
          "inline-block w-1.5 h-1.5 rounded-full shrink-0",
          done ? "bg-emerald-500" : active ? "bg-amber-500 animate-pulse" : "bg-muted",
        )}
      />
      <span className={cn(done ? "text-foreground" : active ? "text-foreground" : "text-muted-foreground")}>
        {label}
      </span>
    </div>
  )
}
