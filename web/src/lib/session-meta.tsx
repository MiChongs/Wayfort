import type { LucideIcon } from "lucide-react"
import {
  AlertTriangle,
  Box,
  Cloud,
  Copy,
  Download,
  FilePen,
  FolderPlus,
  Info,
  LogIn,
  LogOut,
  Maximize2,
  Monitor,
  Network,
  Power,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react"
import type { SessionKind, SessionStatus } from "@/lib/api/types"

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

// Audit timeline taxonomy. Each backend event kind maps to a human label, an
// icon, a coarse group (so the detail page can filter), and a tone.
type AuditGroup = "command" | "file" | "lifecycle"
type AuditMeta = { label: string; icon: LucideIcon; group: AuditGroup; tone: BadgeTone }

const AUDIT_META: Record<string, AuditMeta> = {
  command: { label: "命令", icon: Terminal, group: "command", tone: "coral" },
  "session.start": { label: "会话开始", icon: LogIn, group: "lifecycle", tone: "soft" },
  "session.end": { label: "会话结束", icon: LogOut, group: "lifecycle", tone: "soft" },
  "session.terminate": { label: "强制下线", icon: Power, group: "lifecycle", tone: "warning" },
  resize: { label: "调整窗口", icon: Maximize2, group: "lifecycle", tone: "secondary" },
  "graphical.start": { label: "桌面接入", icon: Monitor, group: "lifecycle", tone: "info" },
  "graphical.error": { label: "桌面错误", icon: AlertTriangle, group: "lifecycle", tone: "destructive" },
  "anonymous.launch": { label: "沙箱启动", icon: Box, group: "lifecycle", tone: "warning" },
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
