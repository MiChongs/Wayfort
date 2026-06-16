"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { format, isToday, isYesterday } from "date-fns"
import { zhCN } from "date-fns/locale"
import {
  Bot,
  CircleCheck,
  CircleX,
  Clock,
  Globe,
  History,
  Lock,
  Monitor,
  ShieldAlert,
  ShieldX,
  Smartphone,
  Tablet,
} from "lucide-react"
import { meService } from "@/lib/api/services"
import type { LoginHistory } from "@/lib/api/types"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/common/empty-state"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"

type Tone = "success" | "danger" | "warning"

// ----- humanising lookups --------------------------------------------------
// The backend stores terse enum values (see internal/model/login_history.go).
// These maps turn them into something a person reads at a glance: a plain-
// language outcome, a matching icon, and a warm semantic tone.

const RESULT_META: Record<
  string,
  { label: string; tone: Tone; icon: React.ComponentType<{ className?: string }> }
> = {
  success: { label: "登录成功", tone: "success", icon: CircleCheck },
  fail: { label: "登录失败", tone: "danger", icon: CircleX },
  locked: { label: "账号已锁定", tone: "danger", icon: Lock },
  mfa_required: { label: "等待二次验证", tone: "warning", icon: ShieldAlert },
  mfa_failed: { label: "二次验证失败", tone: "danger", icon: ShieldX },
}

const AUTH_LABEL: Record<string, string> = {
  password: "密码",
  passkey: "通行密钥",
  oidc: "单点登录",
  recovery: "恢复码",
}

const MFA_LABEL: Record<string, string> = {
  none: "",
  totp: "动态口令",
  email: "邮箱验证码",
  passkey: "通行密钥",
  recovery: "恢复码",
}

const TONE_CIRCLE: Record<Tone, string> = {
  success: "bg-success/12 text-success",
  danger: "bg-destructive/12 text-destructive",
  warning: "bg-warning/15 text-warning",
}

function resultMeta(result: string) {
  return RESULT_META[result] ?? { label: result || "未知结果", tone: "warning" as Tone, icon: ShieldAlert }
}

// ----- user-agent → friendly device -----------------------------------------
type DeviceKind = "desktop" | "mobile" | "tablet" | "bot" | "unknown"

const DEVICE_ICON: Record<DeviceKind, React.ComponentType<{ className?: string }>> = {
  desktop: Monitor,
  mobile: Smartphone,
  tablet: Tablet,
  bot: Bot,
  unknown: Globe,
}

function parseUA(ua: string): { browser: string; os: string; device: DeviceKind } {
  if (!ua) return { browser: "未知客户端", os: "", device: "unknown" }

  let os = ""
  if (/iPhone|iPad|iPod/.test(ua)) os = "iOS"
  else if (/Android/.test(ua)) os = "Android"
  else if (/Windows/.test(ua)) os = "Windows"
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS"
  else if (/CrOS/.test(ua)) os = "ChromeOS"
  else if (/Linux/.test(ua)) os = "Linux"

  let browser = ""
  if (/Edg\//.test(ua)) browser = "Edge"
  else if (/OPR\/|Opera/.test(ua)) browser = "Opera"
  else if (/Firefox\//.test(ua)) browser = "Firefox"
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = "Chrome"
  else if (/Version\/.*Safari\//.test(ua)) browser = "Safari"
  else if (/curl\//i.test(ua)) browser = "curl"
  else if (/PostmanRuntime/i.test(ua)) browser = "Postman"
  else if (/python-requests|Go-http-client|okhttp/i.test(ua)) browser = "脚本客户端"

  let device: DeviceKind = "desktop"
  if (/bot|spider|crawl|curl|wget|python-requests|PostmanRuntime|Go-http-client/i.test(ua)) device = "bot"
  else if (/iPad|Tablet/.test(ua)) device = "tablet"
  else if (/Mobile|iPhone|Android/.test(ua)) device = "mobile"

  return { browser: browser || "未知浏览器", os, device }
}

function deviceLabel(ua: string): string {
  const { browser, os } = parseUA(ua)
  return os ? `${browser} · ${os}` : browser
}

function dayLabel(s: string): string {
  const d = new Date(s)
  if (isToday(d)) return "今天"
  if (isYesterday(d)) return "昨天"
  try {
    return format(d, "yyyy年M月d日 EEEE", { locale: zhCN })
  } catch {
    return s
  }
}

// ----- page ------------------------------------------------------------------
export default function LoginHistoryPage() {
  const q = useQuery({ queryKey: ["me", "login-history"], queryFn: () => meService.loginHistory(100) })
  const history = React.useMemo(() => q.data?.history ?? [], [q.data])

  const stats = React.useMemo(() => {
    let success = 0
    let failed = 0
    let anomaly = 0
    for (const h of history) {
      if (h.result === "success") success++
      else if (h.result === "fail" || h.result === "locked" || h.result === "mfa_failed") failed++
      if (h.anomaly) anomaly++
    }
    return { success, failed, anomaly }
  }, [history])

  // Group chronologically into day buckets, preserving the server's
  // newest-first order so the timeline reads top-down from "今天".
  const groups = React.useMemo(() => {
    const out: { key: string; label: string; items: LoginHistory[] }[] = []
    for (const h of history) {
      const key = (() => {
        try {
          return format(new Date(h.created_at), "yyyy-MM-dd")
        } catch {
          return h.created_at.slice(0, 10)
        }
      })()
      const last = out[out.length - 1]
      if (last && last.key === key) last.items.push(h)
      else out.push({ key, label: dayLabel(h.created_at), items: [h] })
    }
    return out
  }, [history])

  const latest = history[0]

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <History className="w-5 h-5" /> 登录历史
        </h1>
        <p className="text-sm text-muted-foreground">这里记录了你账号每一次登录的时间、设备与结果，请留意陌生的登录。</p>
      </div>

      {q.isLoading ? (
        <LoadingState />
      ) : history.length === 0 ? (
        <div className="rounded-xl border">
          <EmptyState icon={Clock} title="暂无登录记录" description="当你登录账号后，记录会出现在这里。" />
        </div>
      ) : (
        <>
          {/* Overview — the most recent login + lifetime tallies. */}
          <div className="rounded-xl border bg-card p-4 sm:p-5">
            {latest && <LatestLogin record={latest} />}
            <div className="mt-4 grid grid-cols-3 gap-2 border-t pt-4">
              <Stat tone="success" label="成功" value={stats.success} />
              <Stat tone="danger" label="失败" value={stats.failed} />
              <Stat tone="warning" label="异常" value={stats.anomaly} />
            </div>
          </div>

          {/* Anomaly nudge — actionable, not alarmist. */}
          {stats.anomaly > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4">
              <ShieldAlert className="w-5 h-5 text-warning shrink-0 mt-0.5" />
              <div className="min-w-0 text-sm">
                <p className="font-medium">检测到 {stats.anomaly} 次异常登录</p>
                <p className="text-muted-foreground mt-0.5">
                  若不是你本人操作，建议立即{" "}
                  <Link href="/me/security" className="text-primary font-medium hover:underline">
                    修改密码并启用多因子认证
                  </Link>
                  。
                </p>
              </div>
            </div>
          )}

          {/* Timeline grouped by day. */}
          <div className="space-y-5">
            {groups.map((g) => (
              <section key={g.key} className="space-y-2">
                <h2 className="text-xs font-medium text-muted-foreground px-1">{g.label}</h2>
                <ul className="rounded-xl border divide-y overflow-hidden bg-card">
                  {g.items.map((h) => (
                    <LoginRow key={h.id} record={h} />
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <p className="text-xs text-muted-foreground text-center">
            共显示最近 {history.length} 条登录记录
          </p>
        </>
      )}
    </div>
  )
}

// ----- pieces ----------------------------------------------------------------

function LatestLogin({ record }: { record: LoginHistory }) {
  const meta = resultMeta(record.result)
  const { device } = parseUA(record.user_agent)
  const DeviceIcon = DEVICE_ICON[device]
  return (
    <div className="flex items-center gap-3.5">
      <div className={cn("w-11 h-11 rounded-full flex items-center justify-center shrink-0", TONE_CIRCLE[meta.tone])}>
        <DeviceIcon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">最近登录</span>
          <span className="text-xs text-muted-foreground" title={fullTime(record.created_at)}>
            {relTime(record.created_at)}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground truncate" title={record.user_agent}>
          {meta.label} · {deviceLabel(record.user_agent)} · <span className="font-mono">{record.ip}</span>
        </p>
      </div>
    </div>
  )
}

function Stat({ tone, label, value }: { tone: Tone; label: string; value: number }) {
  const dot = tone === "success" ? "bg-success" : tone === "danger" ? "bg-destructive" : "bg-warning"
  return (
    <div className="flex flex-col items-center justify-center rounded-lg bg-muted/40 py-2.5">
      <span className="text-xl font-semibold tabular-nums leading-none">{value}</span>
      <span className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("w-1.5 h-1.5 rounded-full", dot)} />
        {label}
      </span>
    </div>
  )
}

function LoginRow({ record }: { record: LoginHistory }) {
  const meta = resultMeta(record.result)
  const { device } = parseUA(record.user_agent)
  const DeviceIcon = DEVICE_ICON[device]
  const ResultIcon = meta.icon
  const auth = AUTH_LABEL[record.auth_method] ?? record.auth_method
  const mfa = MFA_LABEL[record.mfa_method] ?? ""
  const showReason = record.reason && record.result !== "success"

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0", TONE_CIRCLE[meta.tone])}>
        <ResultIcon className="w-4 h-4" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{meta.label}</span>
          {auth && <Badge variant="soft" className="rounded-full">{auth}</Badge>}
          {mfa && (
            <Badge variant="soft" className="rounded-full">
              + {mfa}
            </Badge>
          )}
          {record.anomaly && (
            <Badge variant="warning" className="rounded-full gap-1">
              <ShieldAlert className="w-3 h-3" /> 异常
            </Badge>
          )}
        </div>

        <div
          className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap"
          title={record.user_agent}
        >
          <DeviceIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate max-w-[14rem]">{deviceLabel(record.user_agent)}</span>
          <span className="text-border">·</span>
          <span className="font-mono">{record.ip}</span>
        </div>

        {showReason && <p className="mt-1 text-xs text-destructive/90 break-words">{record.reason}</p>}
      </div>

      <time className="shrink-0 text-xs text-muted-foreground tabular-nums" title={fullTime(record.created_at)}>
        {format(new Date(record.created_at), "HH:mm")}
      </time>
    </li>
  )
}

function LoadingState() {
  return (
    <>
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="flex items-center gap-3.5">
          <Skeleton className="w-11 h-11 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 border-t pt-4">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      </div>
      <div className="rounded-xl border bg-card divide-y overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="w-9 h-9 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-52" />
            </div>
            <Skeleton className="h-3 w-10 shrink-0" />
          </div>
        ))}
      </div>
    </>
  )
}
