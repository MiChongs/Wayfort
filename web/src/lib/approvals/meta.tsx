import {
  CheckCircle2,
  Clock,
  DatabaseZap,
  FileKey,
  FileUp,
  KeyRound,
  LifeBuoy,
  ScrollText,
  ServerCog,
  ShieldAlert,
  Terminal,
  TimerReset,
  UserCog,
  XCircle,
  Slash,
  Zap,
  type LucideIcon,
} from "lucide-react"
import type {
  ApprovalBusinessType,
  ApprovalGrantStatus,
  ApprovalRequestStatus,
  ApprovalRiskLevel,
  ApprovalStageMode,
  ApprovalTaskState,
} from "@/lib/api/types"

// Single source of truth for every approval enum's Chinese label, colour, and
// icon. Pages, the workspace gate panel, and the admin console all read from
// here so a枚举永远不会以英文裸值出现在界面上。

// ---- business type ----

export const BIZ_LABELS: Record<ApprovalBusinessType, string> = {
  asset_access: "资产访问",
  credential_use: "凭据使用",
  command_exec: "命令执行",
  sql_exec: "SQL 执行",
  file_transfer: "文件传输",
  session_extend: "会话续期",
  session_elevate: "会话提权",
  break_glass: "应急访问",
  vendor_access: "第三方访问",
  audit_view: "审计查阅",
}

export const BIZ_ICONS: Record<ApprovalBusinessType, LucideIcon> = {
  asset_access: ServerCog,
  credential_use: KeyRound,
  command_exec: Terminal,
  sql_exec: DatabaseZap,
  file_transfer: FileUp,
  session_extend: TimerReset,
  session_elevate: UserCog,
  break_glass: LifeBuoy,
  vendor_access: FileKey,
  audit_view: ScrollText,
}

export const BIZ_HINTS: Record<ApprovalBusinessType, string> = {
  asset_access: "申请连接一台受控资产",
  credential_use: "申请使用一份托管凭据",
  command_exec: "申请在会话中执行受限命令",
  sql_exec: "申请执行数据库写操作",
  file_transfer: "申请上传或下载文件",
  session_extend: "申请延长当前会话时长",
  session_elevate: "申请在会话中临时提权",
  break_glass: "紧急情况下的应急访问，短时高危",
  vendor_access: "外部厂商的受限访问",
  audit_view: "申请查阅敏感审计记录",
}

export function bizLabel(t?: string): string {
  return (t && BIZ_LABELS[t as ApprovalBusinessType]) || t || "—"
}

// ---- request status ----

interface ToneMeta {
  label: string
  icon: LucideIcon
  /** badge surface — tinted background + readable text */
  badge: string
  /** small leading dot colour */
  dot: string
}

export const STATUS_META: Record<ApprovalRequestStatus, ToneMeta> = {
  pending: {
    label: "待审批",
    icon: Clock,
    badge: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  approved: {
    label: "已通过",
    icon: CheckCircle2,
    badge: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  auto_approved: {
    label: "自动通过",
    icon: Zap,
    badge: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  rejected: {
    label: "已驳回",
    icon: XCircle,
    badge: "bg-destructive/12 text-destructive",
    dot: "bg-destructive",
  },
  cancelled: {
    label: "已撤销",
    icon: Slash,
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
  expired: {
    label: "已超时",
    icon: Clock,
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
}

export function statusMeta(s?: string): ToneMeta {
  return STATUS_META[s as ApprovalRequestStatus] ?? STATUS_META.pending
}

// ---- risk level ----

export const RISK_META: Record<ApprovalRiskLevel, ToneMeta> = {
  low: {
    label: "低风险",
    icon: ShieldAlert,
    badge: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  medium: {
    label: "中风险",
    icon: ShieldAlert,
    badge: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  high: {
    label: "高风险",
    icon: ShieldAlert,
    badge: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  critical: {
    label: "严重",
    icon: ShieldAlert,
    badge: "bg-destructive/12 text-destructive",
    dot: "bg-destructive",
  },
}

export function riskMeta(r?: string): ToneMeta {
  return RISK_META[r as ApprovalRiskLevel] ?? RISK_META.medium
}

export const RISK_RANK: Record<ApprovalRiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

// ---- stage mode ----

export const STAGE_MODE_LABELS: Record<ApprovalStageMode, string> = {
  all: "会签",
  any: "或签",
  quorum: "法定人数",
}

export const STAGE_MODE_HINTS: Record<ApprovalStageMode, string> = {
  all: "本级每位审批人都必须通过",
  any: "本级任一审批人通过即可",
  quorum: "本级达到指定人数通过即可",
}

export function stageModeLabel(m: ApprovalStageMode, quorumN?: number): string {
  if (m === "quorum") return `法定 ${quorumN ?? 1} 人`
  return STAGE_MODE_LABELS[m] ?? m
}

// ---- task state ----

export const TASK_STATE_META: Record<ApprovalTaskState, ToneMeta> = {
  pending: {
    label: "待处理",
    icon: Clock,
    badge: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  approved: {
    label: "已通过",
    icon: CheckCircle2,
    badge: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  rejected: {
    label: "已驳回",
    icon: XCircle,
    badge: "bg-destructive/12 text-destructive",
    dot: "bg-destructive",
  },
  delegated: {
    label: "已转交",
    icon: UserCog,
    badge: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  expired: {
    label: "已超时",
    icon: Clock,
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
  skipped: {
    label: "已跳过",
    icon: Slash,
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
}

export function taskStateMeta(s?: string): ToneMeta {
  return TASK_STATE_META[s as ApprovalTaskState] ?? TASK_STATE_META.pending
}

// ---- grant status ----

export const GRANT_STATUS_META: Record<ApprovalGrantStatus, ToneMeta> = {
  active: {
    label: "生效中",
    icon: CheckCircle2,
    badge: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  expired: {
    label: "已到期",
    icon: Clock,
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
  revoked: {
    label: "已收回",
    icon: XCircle,
    badge: "bg-destructive/12 text-destructive",
    dot: "bg-destructive",
  },
  used_up: {
    label: "次数用尽",
    icon: Slash,
    badge: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
}

export function grantStatusMeta(s?: string): ToneMeta {
  return GRANT_STATUS_META[s as ApprovalGrantStatus] ?? GRANT_STATUS_META.active
}

// ---- resource type ----

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  node: "节点",
  credential: "凭据",
  session: "会话",
}

export function resourceTypeLabel(t?: string): string {
  if (!t) return ""
  return RESOURCE_TYPE_LABELS[t] ?? t
}

// ---- audit ledger event kinds ----

export const EVENT_LABEL: Record<string, string> = {
  "request.created": "提交申请",
  "policy.matched": "匹配审批策略",
  "policy.risk_computed": "评估风险等级",
  "request.auto_approved": "自动通过",
  "task.created": "指派审批人",
  "task.approved": "审批人通过",
  "task.rejected": "审批人驳回",
  "task.delegated": "转交审批",
  "task.expired": "审批超时",
  "task.skipped": "跳过审批",
  "stage.advanced": "进入下一级",
  "request.approved": "审批通过",
  "request.rejected": "审批驳回",
  "request.cancelled": "已撤销",
  "request.expired": "已超时",
  "grant.issued": "授权签发",
  "grant.verified": "授权核验",
  "grant.revoked": "授权收回",
  "grant.expired": "授权到期",
  "notify.sent": "通知已送达",
  "notify.failed": "通知发送失败",
}

export function eventLabel(kind: string): string {
  return EVENT_LABEL[kind] ?? kind
}

/** Event kinds an admin can subscribe a notification channel to. */
export const SUBSCRIBABLE_EVENTS: { value: string; label: string }[] = [
  { value: "request.created", label: "提交申请" },
  { value: "task.created", label: "指派审批人" },
  { value: "request.approved", label: "审批通过" },
  { value: "request.rejected", label: "审批驳回" },
  { value: "request.auto_approved", label: "自动通过" },
  { value: "request.cancelled", label: "已撤销" },
  { value: "request.expired", label: "已超时" },
  { value: "grant.issued", label: "授权签发" },
  { value: "grant.revoked", label: "授权收回" },
]

// ---- notification channels ----

export const CHANNEL_LABELS: Record<string, string> = {
  webhook: "Webhook",
  email: "邮件",
  feishu: "飞书",
  dingtalk: "钉钉",
  wecom: "企业微信",
  slack: "Slack",
  teams: "Teams",
  siem: "SIEM",
}

export const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label }))

// ---- duration helpers ----

export const DURATION_PRESETS: { label: string; sec: number }[] = [
  { label: "30 分钟", sec: 1800 },
  { label: "1 小时", sec: 3600 },
  { label: "2 小时", sec: 2 * 3600 },
  { label: "4 小时", sec: 4 * 3600 },
  { label: "8 小时", sec: 8 * 3600 },
  { label: "1 天", sec: 24 * 3600 },
]

/** Humanise a duration in seconds (e.g. 5400 → "1 小时 30 分钟"). */
export function formatDuration(sec: number): string {
  if (sec <= 0) return "—"
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const parts: string[] = []
  if (d) parts.push(`${d} 天`)
  if (h) parts.push(`${h} 小时`)
  if (m && !d) parts.push(`${m} 分钟`)
  return parts.join(" ") || `${sec} 秒`
}
