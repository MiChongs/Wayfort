import {
  CheckCircle2,
  Clock,
  LifeBuoy,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Slash,
  TimerOff,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react"
import type {
  BreakGlassMode,
  BreakGlassReviewVerdict,
  BreakGlassScopeType,
  BreakGlassStatus,
} from "@/lib/api/types"

// Single source of truth for break-glass (应急访问) enum labels, colours, and
// icons — pages and dialogs read from here so an enum never shows as a raw
// English value. Mirrors the approvals meta convention (badge + dot tailwind).

export interface ToneMeta {
  label: string
  icon: LucideIcon
  /** badge surface — tinted background + readable text */
  badge: string
  /** small leading dot colour */
  dot: string
}

const MUTED: Pick<ToneMeta, "badge" | "dot"> = {
  badge: "bg-muted text-muted-foreground",
  dot: "bg-muted-foreground/60",
}

export const BG_STATUS_META: Record<BreakGlassStatus, ToneMeta> = {
  pending: {
    label: "待审批",
    icon: Clock,
    badge: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  active: {
    label: "进行中",
    icon: Zap,
    badge: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  under_review: {
    label: "待复核",
    icon: Loader2,
    badge: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  closed: {
    label: "已闭环",
    icon: CheckCircle2,
    badge: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  expired: { label: "已到期", icon: TimerOff, ...MUTED },
  revoked: {
    label: "已吊销",
    icon: XCircle,
    badge: "bg-destructive/12 text-destructive",
    dot: "bg-destructive",
  },
  rejected: {
    label: "已驳回",
    icon: Slash,
    badge: "bg-destructive/12 text-destructive",
    dot: "bg-destructive",
  },
}

export function bgStatusMeta(s?: string): ToneMeta {
  return BG_STATUS_META[s as BreakGlassStatus] ?? BG_STATUS_META.pending
}

export const BG_MODE_META: Record<BreakGlassMode, { label: string; icon: LucideIcon; hint: string }> = {
  pre_approved: {
    label: "审批激活",
    icon: ShieldCheck,
    hint: "需经审批人加速批准后开通访问",
  },
  fail_open: {
    label: "自助破玻璃",
    icon: LifeBuoy,
    hint: "无需事前审批立即开通，事后强制复核（fail-open）",
  },
}

export function bgModeMeta(m?: string) {
  return BG_MODE_META[m as BreakGlassMode] ?? BG_MODE_META.pre_approved
}

export const BG_SCOPE_LABELS: Record<BreakGlassScopeType, string> = {
  all: "全部资产",
  tag: "指定标签",
  node: "指定资产",
}

export const BG_VERDICT_META: Record<BreakGlassReviewVerdict, ToneMeta> = {
  justified: {
    label: "正当",
    icon: ShieldCheck,
    badge: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  unjustified: {
    label: "不正当",
    icon: ShieldAlert,
    badge: "bg-destructive/12 text-destructive",
    dot: "bg-destructive",
  },
  inconclusive: {
    label: "存疑",
    icon: ShieldAlert,
    badge: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
}

export function bgVerdictMeta(v?: string): ToneMeta | null {
  if (!v) return null
  return BG_VERDICT_META[v as BreakGlassReviewVerdict] ?? null
}

/** Whether an activation is still awaiting a post-use review sign-off. */
export function bgNeedsReview(status?: string, reviewed_at?: string | null): boolean {
  return status === "under_review" && !reviewed_at
}

// ---- input shortcuts (减少输入：点选代替打字) ----

// Common emergency-access reasons. Tapping one fills the justification so the
// operator types nothing in the typical case (they can still edit / append).
export const BG_REASON_TEMPLATES: { label: string; text: string }[] = [
  { label: "生产故障排查", text: "生产环境故障，需立即登录目标资产排查并恢复服务。" },
  { label: "服务不可用恢复", text: "目标服务不可用，需应急介入重启 / 回滚以恢复可用性。" },
  { label: "数据库恢复", text: "数据库异常，需应急执行修复 / 恢复操作以止损。" },
  { label: "安全事件处置", text: "正在处置安全事件，需应急访问目标资产取证与遏制。" },
  { label: "紧急配置变更", text: "需紧急变更目标资产配置以缓解线上问题。" },
  { label: "值班审批人不可达", text: "常规审批人当前不可达，按应急流程申请破玻璃访问。" },
]

// Duration presets — one tap instead of typing minutes. The dialog clamps these
// to the governing policy's max on the server side regardless.
export const BG_DURATION_PRESETS: { label: string; sec: number }[] = [
  { label: "15 分钟", sec: 15 * 60 },
  { label: "30 分钟", sec: 30 * 60 },
  { label: "1 小时", sec: 60 * 60 },
  { label: "2 小时", sec: 120 * 60 },
]

// The compensating controls every break-glass activation carries — surfaced in
// the UI so the operator understands what they're triggering (人性化透明).
export const BG_CONSEQUENCES: { label: string; icon: LucideIcon }[] = [
  { label: "即时通知安全团队", icon: ShieldAlert },
  { label: "全程录制可回放", icon: ShieldCheck },
  { label: "到期自动回收", icon: TimerOff },
  { label: "事后强制复核", icon: Loader2 },
]

/** Whether an activation can still be revoked (kill-switch). */
export function bgRevocable(status?: string): boolean {
  return status === "active" || status === "pending"
}

/** Human countdown helper: seconds remaining until an ISO deadline. */
export function bgSecondsLeft(notAfter?: string | null): number | null {
  if (!notAfter) return null
  const ms = new Date(notAfter).getTime() - Date.now()
  return ms <= 0 ? 0 : Math.floor(ms / 1000)
}

export function bgFormatRemaining(notAfter?: string | null): string {
  const s = bgSecondsLeft(notAfter)
  if (s == null) return "—"
  if (s <= 0) return "已到期"
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m <= 0) return `${sec}s`
  if (m < 60) return `${m}m ${sec}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
