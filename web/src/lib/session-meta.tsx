import type { LucideIcon } from "lucide-react"
import {
  Activity,
  AlertTriangle,
  Box,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  ClipboardX,
  Cloud,
  Cog,
  Container,
  Copy,
  Cpu,
  Download,
  Eye,
  FilePen,
  FileText,
  FolderPlus,
  HardDrive,
  Info,
  KeyRound,
  LifeBuoy,
  LogIn,
  LogOut,
  Maximize2,
  Monitor,
  Network,
  Package,
  Power,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Terminal,
  Trash2,
  Upload,
  UserCog,
  Wrench,
} from "lucide-react"
import type { SessionKind, SessionStatus, SessionPhaseKind } from "@/lib/api/types"

type BadgeTone =
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "destructive"
  | "soft"
  | "coral"
  | "info"

// Humanised metadata for a session kind. The backend stores a coarse machine
// enum; the UI never shows it raw.
export const KIND_META: Record<
  SessionKind,
  { label: string; short: string; icon: LucideIcon; tone: BadgeTone }
> = {
  interactive: { label: "终端会话", short: "终端", icon: Terminal, tone: "coral" },
  graphical: { label: "图形桌面", short: "桌面", icon: Monitor, tone: "info" },
  sftp: { label: "文件传输", short: "SFTP", icon: Upload, tone: "soft" },
  oss: { label: "对象存储", short: "对象存储", icon: Cloud, tone: "soft" },
  tcp_forward: { label: "端口转发", short: "转发", icon: Network, tone: "soft" },
  anonymous: { label: "匿名沙箱", short: "沙箱", icon: Box, tone: "warning" },
}

export function kindMeta(kind: string) {
  return (
    KIND_META[kind as SessionKind] ?? {
      label: kind,
      short: kind,
      icon: Terminal,
      tone: "secondary" as BadgeTone,
    }
  )
}

export const STATUS_META: Record<
  SessionStatus,
  { label: string; tone: BadgeTone; live?: boolean }
> = {
  active: { label: "进行中", tone: "success", live: true },
  closed: { label: "已结束", tone: "outline" },
  terminated: { label: "已下线", tone: "warning" },
  errored: { label: "异常中断", tone: "destructive" },
}

export function statusMeta(status: string) {
  return (
    STATUS_META[status as SessionStatus] ?? {
      label: status,
      tone: "secondary" as BadgeTone,
    }
  )
}

// Connection-stage metadata for the lifecycle gantt + timeline. The `accent`
// key names the viz token (see lib/viz/theme) so a phase bar's colour is a
// single source of truth across the gantt and the legend.
export const PHASE_META: Record<
  SessionPhaseKind,
  { label: string; icon: LucideIcon; accent: "neutral" | "amber" | "teal" | "coral" }
> = {
  dial: { label: "建立连接", icon: Network, accent: "neutral" },
  auth: { label: "身份认证", icon: KeyRound, accent: "amber" },
  handshake: { label: "协议握手", icon: Activity, accent: "teal" },
  ready: { label: "会话就绪", icon: ShieldCheck, accent: "coral" },
  reconnect: { label: "重新连接", icon: Eye, accent: "amber" },
  closed: { label: "已关闭", icon: LogOut, accent: "neutral" },
}

export function phaseMeta(phase: string) {
  return (
    PHASE_META[phase as SessionPhaseKind] ?? {
      label: phase,
      icon: Activity,
      accent: "neutral" as const,
    }
  )
}

// Audit timeline taxonomy. Each backend event kind maps to a human label, an
// icon, a coarse group (so the detail page can filter), and a tone.
type AuditGroup = "command" | "file" | "lifecycle"
type AuditMeta = { label: string; icon: LucideIcon; group: AuditGroup; tone: BadgeTone }

const AUDIT_META: Record<string, AuditMeta> = {
  command: { label: "命令", icon: Terminal, group: "command", tone: "coral" },
  "session.start": { label: "会话开始", icon: LogIn, group: "lifecycle", tone: "soft" },
  "session.end": { label: "会话结束", icon: LogOut, group: "lifecycle", tone: "soft" },
  "session.terminate": { label: "强制下线", icon: Power, group: "lifecycle", tone: "warning" },
  "session.phase": { label: "连接阶段", icon: Activity, group: "lifecycle", tone: "soft" },
  "session.reconnect": { label: "重新连接", icon: Activity, group: "lifecycle", tone: "warning" },
  "session.observe": { label: "实时监看", icon: Eye, group: "lifecycle", tone: "info" },
  "graphical.clipboard": { label: "剪贴板", icon: ClipboardList, group: "file", tone: "secondary" },
  "graphical.file": { label: "桌面文件", icon: Upload, group: "file", tone: "info" },
  "graphical.resize": { label: "调整窗口", icon: Maximize2, group: "lifecycle", tone: "secondary" },
  resize: { label: "调整窗口", icon: Maximize2, group: "lifecycle", tone: "secondary" },
  "graphical.start": { label: "桌面接入", icon: Monitor, group: "lifecycle", tone: "info" },
  "graphical.error": { label: "桌面错误", icon: AlertTriangle, group: "lifecycle", tone: "destructive" },
  "anonymous.launch": { label: "沙箱启动", icon: Box, group: "lifecycle", tone: "warning" },
  "anonymous.reap": { label: "沙箱销毁", icon: Trash2, group: "lifecycle", tone: "secondary" },
  "file.upload": { label: "上传文件", icon: Upload, group: "file", tone: "info" },
  "file.download": { label: "下载文件", icon: Download, group: "file", tone: "soft" },
  "file.delete": { label: "删除文件", icon: Trash2, group: "file", tone: "destructive" },
  "file.rename": { label: "重命名", icon: FilePen, group: "file", tone: "secondary" },
  "file.chmod": { label: "改权限", icon: FilePen, group: "file", tone: "secondary" },
  "file.mkdir": { label: "新建目录", icon: FolderPlus, group: "file", tone: "secondary" },
  "file.write": { label: "写入文件", icon: FilePen, group: "file", tone: "secondary" },
  "oss.list": { label: "浏览对象", icon: Info, group: "file", tone: "secondary" },
  "oss.download": { label: "下载对象", icon: Download, group: "file", tone: "soft" },
  "oss.upload": { label: "上传对象", icon: Upload, group: "file", tone: "info" },
  "oss.delete": { label: "删除对象", icon: Trash2, group: "file", tone: "destructive" },
  "oss.mkdir": { label: "新建前缀", icon: FolderPlus, group: "file", tone: "secondary" },
  "oss.copy": { label: "复制对象", icon: Copy, group: "file", tone: "secondary" },
  "portforward.open": { label: "开启转发", icon: Network, group: "lifecycle", tone: "soft" },
  "portforward.close": { label: "关闭转发", icon: Network, group: "lifecycle", tone: "secondary" },
  // Authentication — populated by the login flow.
  "auth.login": { label: "登录成功", icon: LogIn, group: "lifecycle", tone: "success" },
  "auth.login_failed": { label: "登录失败", icon: ShieldX, group: "lifecycle", tone: "destructive" },
  // Server-management actions executed over SSH.
  "firewall.change": { label: "防火墙变更", icon: ShieldAlert, group: "lifecycle", tone: "warning" },
  "docker.action": { label: "容器操作", icon: Container, group: "lifecycle", tone: "info" },
  "service.action": { label: "服务操作", icon: Cog, group: "lifecycle", tone: "secondary" },
  "process.action": { label: "进程操作", icon: Activity, group: "lifecycle", tone: "warning" },
  "cron.change": { label: "定时任务", icon: CalendarClock, group: "lifecycle", tone: "secondary" },
  "package.action": { label: "软件包", icon: Package, group: "lifecycle", tone: "secondary" },
  "storage.action": { label: "存储操作", icon: HardDrive, group: "lifecycle", tone: "secondary" },
  "kernel.change": { label: "内核参数", icon: Cpu, group: "lifecycle", tone: "warning" },
  "sysuser.action": { label: "系统用户", icon: UserCog, group: "lifecycle", tone: "warning" },
  "network.action": { label: "网络变更", icon: Network, group: "lifecycle", tone: "warning" },
  "security.action": { label: "安全加固", icon: ShieldCheck, group: "lifecycle", tone: "success" },
  // Governance.
  "approval.request": { label: "审批申请", icon: ClipboardList, group: "lifecycle", tone: "soft" },
  "approval.decide": { label: "审批裁决", icon: ClipboardCheck, group: "lifecycle", tone: "info" },
  "approval.revoke": { label: "审批撤销", icon: ClipboardX, group: "lifecycle", tone: "warning" },
  "config.change": { label: "配置变更", icon: Settings, group: "lifecycle", tone: "warning" },
  // Break-glass (应急访问) lifecycle.
  "breakglass.request": { label: "应急申请", icon: LifeBuoy, group: "lifecycle", tone: "warning" },
  "breakglass.activate": { label: "应急开通", icon: LifeBuoy, group: "lifecycle", tone: "warning" },
  "breakglass.expire": { label: "应急到期", icon: ShieldAlert, group: "lifecycle", tone: "secondary" },
  "breakglass.revoke": { label: "应急吊销", icon: ShieldX, group: "lifecycle", tone: "destructive" },
  "breakglass.review": { label: "应急复核", icon: ShieldCheck, group: "lifecycle", tone: "info" },
}

export function auditMeta(kind: string): AuditMeta {
  return (
    AUDIT_META[kind] ?? {
      label: kind,
      icon: Info,
      group: "lifecycle",
      tone: "secondary",
    }
  )
}

// ----- Audit center: six human lanes -----
//
// The global audit center groups 47 raw kinds into six lanes that mirror the
// backend's model.AuditCategoryOf. The backend already stamps each row with its
// `category`, so the UI mostly reads that field and looks up the metadata here;
// auditCategoryOf is the fallback for client-synthesised rows.

export type AuditCategory = "session" | "command" | "file" | "auth" | "ops" | "oss"

export const AUDIT_CATEGORY_META: Record<
  AuditCategory,
  { label: string; icon: LucideIcon; tone: BadgeTone }
> = {
  session: { label: "会话", icon: Monitor, tone: "soft" },
  command: { label: "命令", icon: Terminal, tone: "coral" },
  file: { label: "文件", icon: FileText, tone: "info" },
  auth: { label: "认证", icon: KeyRound, tone: "secondary" },
  ops: { label: "运维", icon: Wrench, tone: "warning" },
  oss: { label: "对象存储", icon: Cloud, tone: "soft" },
}

// Ordered lane list for the segmented control (matches model.AuditCategories).
export const AUDIT_CATEGORIES: AuditCategory[] = [
  "session", "command", "file", "auth", "ops", "oss",
]

const KIND_CATEGORY: Record<string, AuditCategory> = {
  command: "command",
  "auth.login": "auth",
  "auth.login_failed": "auth",
}
// Derive the rest from kind prefixes so the table never needs the backend round-trip.
const CATEGORY_BY_PREFIX: [string, AuditCategory][] = [
  ["session.", "session"],
  ["graphical.", "session"],
  ["anonymous.", "session"],
  ["portforward.", "session"],
  ["resize", "session"],
  ["file.", "file"],
  ["oss.", "oss"],
]

export function auditCategoryOf(kind: string): AuditCategory {
  if (KIND_CATEGORY[kind]) return KIND_CATEGORY[kind]
  for (const [prefix, cat] of CATEGORY_BY_PREFIX) {
    if (kind === prefix || kind.startsWith(prefix)) return cat
  }
  return "ops" // firewall/docker/service/.../approval/config and any future kind
}

export function categoryMeta(cat: string) {
  return AUDIT_CATEGORY_META[cat as AuditCategory] ?? {
    label: cat,
    icon: Info,
    tone: "secondary" as BadgeTone,
  }
}

// Severity drives the row accent rail + the abnormal focus. The backend already
// computes `abnormal`; this adds a coarse three-step tone for styling.
export type AuditSeverity = "danger" | "warn" | "normal"

const WARN_KINDS = new Set<string>([
  "anonymous.launch", "firewall.change", "kernel.change", "sysuser.action",
  "network.action", "process.action", "approval.revoke", "config.change",
])

export function auditSeverity(row: { kind: string; abnormal?: boolean }): AuditSeverity {
  if (row.abnormal) return "danger"
  if (WARN_KINDS.has(row.kind)) return "warn"
  return "normal"
}

// fmtDuration renders a compact, human session length. For a still-running
// session pass no end and it measures against now.
export function fmtDuration(startISO?: string | null, endISO?: string | null): string {
  if (!startISO) return "—"
  const start = new Date(startISO).getTime()
  const end = endISO ? new Date(endISO).getTime() : Date.now()
  let s = Math.max(0, Math.floor((end - start) / 1000))
  if (s < 60) return `${s} 秒`
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
  if (m > 0) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分钟`
  return `${s} 秒`
}
