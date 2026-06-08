"use client"

import * as React from "react"
import { Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatBytes } from "@/components/insights/format"
import { cn } from "@/lib/utils"

// Shared helpers + small presentational pieces for the WireGuard tool. Keeps the
// view files lean and the warm-tone conventions in one place.

export type WgView = "overview" | "interfaces" | "peers" | "clients" | "gateway" | "config"

/** fmtBytes formats a byte count using the shared KB-based formatter. */
export function fmtBytes(bytes: number): string {
  return formatBytes((bytes || 0) / 1024)
}

/** peerOnline — a peer is "online" when its last handshake is under 3 minutes. */
export function peerOnline(ts: number): boolean {
  if (!ts) return false
  return Math.floor(Date.now() / 1000) - ts < 180
}

// handshakeAge maps the last-handshake epoch to a relative string + warm tone:
// fresh (<3m) sage, stale (<10m) amber, cold/never brick.
export function handshakeAge(ts: number): { text: string; tone: string } {
  if (!ts) return { text: "从未", tone: "text-muted-foreground" }
  const age = Math.floor(Date.now() / 1000) - ts
  if (age < 0) return { text: "刚刚", tone: "text-success" }
  let text: string
  if (age < 60) text = `${age}s 前`
  else if (age < 3600) text = `${Math.floor(age / 60)}m 前`
  else if (age < 86400) text = `${Math.floor(age / 3600)}h 前`
  else text = `${Math.floor(age / 86400)}d 前`
  const tone = age < 180 ? "text-success" : age < 600 ? "text-warning" : "text-destructive"
  return { text, tone }
}

export function HandshakeBadge({ ts, className }: { ts: number; className?: string }) {
  const hs = handshakeAge(ts)
  return <span className={cn("tabular-nums", hs.tone, className)}>{hs.text}</span>
}

/** errorHint turns a typed backend error code into an actionable Chinese hint. */
export function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|root|password is required/i.test(msg))
    return "需 root / sudo NOPASSWD。换 root 凭据，或为 wg / wg-quick / systemctl / iptables 配置 sudoers。"
  if (code === "unreachable") return "节点 SSH 不可达，检查节点状态与凭据。"
  if (code === "not_installed") return "目标主机未安装 WireGuard，请先一键安装。"
  if (code === "conf_exists") return "同名接口配置已存在，请换一个接口名。"
  if (code === "conf_not_found") return "未找到该接口的配置文件。"
  if (code === "subnet_full") return "接口子网已无可分配地址，请扩大子网或清理对端。"
  if (code === "conflict") return "配置在磁盘上已被修改，请刷新后重试。"
  if (code === "confirm_required") return "该操作需要二次确认。"
  return ""
}

// WgEmpty — centered empty / unavailable state with an optional primary action.
export function WgEmpty({
  title,
  sub,
  action,
}: {
  title: string
  sub?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <Shield className="h-8 w-8 text-muted-foreground/50" />
      <div className="text-sm font-medium text-foreground">{title}</div>
      {sub && <div className="max-w-xs text-xs text-muted-foreground">{sub}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

// SectionHeader — compact toolbar header used at the top of each view.
export function SectionHeader({
  title,
  count,
  children,
}: {
  title: string
  count?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b bg-card px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-semibold tracking-tight">{title}</span>
        {count !== undefined && <span className="shrink-0 text-[10px] text-muted-foreground">{count}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  )
}

/** useElementWidth tracks an element's content width via ResizeObserver so views
 *  can degrade gracefully in the narrow dock panel. */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T | null>(null)
  const [width, setWidth] = React.useState(0)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width)
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

// downloadText triggers a client-side download of a text blob (used for .conf).
export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// PrimaryCTA — the single coral button per dialog (design rule: coral is voltage,
// used only for the one main action).
export function PrimaryCTA(props: React.ComponentProps<typeof Button>) {
  return <Button {...props} />
}
