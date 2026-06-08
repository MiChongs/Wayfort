"use client"

import * as React from "react"
import { ShieldX } from "lucide-react"
import { formatBytes } from "@/components/insights/format"
import type { FirewallRule, FirewallTool, ExposureVerdict } from "@/lib/api/types"
import { cn } from "@/lib/utils"

// Shared helpers + small pieces for the firewall tool. Reuses the WireGuard
// shared utilities (useElementWidth / downloadText / SectionHeader) to stay DRY.
export { useElementWidth, downloadText, SectionHeader, WgEmpty as FwEmpty } from "../wireguard/shared"

export type FwView = "overview" | "rules" | "connections" | "logs" | "fail2ban" | "diagnose"

export function fmtBytes(b: number): string {
  return formatBytes((b || 0) / 1024)
}
export function fmtPkts(n: number): string {
  if (!n) return "0"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

// errorHint maps a typed backend code → actionable Chinese hint.
export function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|root|need to be root|password is required/i.test(msg))
    return "需 root / sudo NOPASSWD。换 root 凭据，或为 ufw/nft/iptables/fail2ban-client 配置 sudoers。"
  if (code === "unreachable") return "节点 SSH 不可达，检查节点状态与凭据。"
  if (code === "no_tool") return "目标主机未安装防火墙工具，请先一键安装。"
  if (code === "confirm_required") return "这是高危改动，需要二次确认。"
  if (code === "already_armed") return "已有一次待确认的安全应用，请先提交或等其回滚。"
  if (code === "ssh_guard_fail") return "该操作会切断当前 SSH 访问，已被拒绝。"
  if (code === "edit_unsupported") return "当前防火墙后端不支持就地编辑/重排。"
  return ""
}

// verdict tone (exposure matrix): open=danger(red), restricted=warning, blocked=safe(green).
export function verdictTone(v: ExposureVerdict): { wash: string; text: string; label: string } {
  switch (v) {
    case "open":
      return { wash: "border-destructive/40 bg-destructive/[0.06]", text: "text-destructive", label: "对外开放" }
    case "restricted":
      return { wash: "border-warning/40 bg-warning/[0.06]", text: "text-warning", label: "受限" }
    case "blocked":
      return { wash: "border-success/40 bg-success/[0.06]", text: "text-success", label: "已拦" }
    default:
      return { wash: "border-border/60", text: "text-muted-foreground", label: "仅本机" }
  }
}

export function actionTone(action: string): string {
  const a = action.toUpperCase()
  if (a === "ALLOW") return "border-success/40 bg-success/[0.08] text-success"
  if (a === "DENY") return "border-destructive/40 bg-destructive/[0.08] text-destructive"
  if (a === "REJECT") return "border-warning/40 bg-warning/[0.08] text-warning"
  return "border-border text-muted-foreground"
}

// ruleKey is stable across SSE frames for per-rule counter history (index can
// shift on reorder, so include raw).
export function ruleKey(r: FirewallRule): string {
  return `${r.chain ?? ""}:${r.family ?? ""}:${r.handle ?? r.index}:${(r.raw ?? "").slice(0, 40)}`
}

// caps describes per-tool capabilities so the UI degrades gracefully.
export function caps(tool: FirewallTool): { edit: boolean; reorder: boolean; enable: boolean } {
  return {
    edit: tool === "ufw" || tool === "nft" || tool === "iptables",
    // reorder is positional — only safe where the index IS the position.
    reorder: tool === "ufw" || tool === "iptables",
    enable: tool === "ufw" || tool === "firewalld",
  }
}

// VerdictPill — non-deformable, never truncated.
export function VerdictPill({ v }: { v: ExposureVerdict }) {
  const t = verdictTone(v)
  return (
    <span className={cn("shrink-0 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium", t.wash, t.text)}>
      {t.label}
    </span>
  )
}

export function FwIconEmpty({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <ShieldX className="h-8 w-8 text-muted-foreground/50" />
      <div className="text-sm font-medium text-foreground">{title}</div>
      {sub && <div className="max-w-xs text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}
