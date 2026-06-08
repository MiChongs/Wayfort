import {
  CircleStop,
  FilePlus,
  FileText,
  FileX,
  FolderTree,
  Play,
  Power,
  ScrollText,
  ShieldAlert,
  Skull,
  Trash2,
  UploadCloud,
  type LucideIcon,
} from "lucide-react"
import { toolFamily } from "@/lib/ai/tool-families"

// Per-tool icon overrides for actions whose meaning is sharper than the family
// default (e.g. a kill is a skull, a delete is a trash can). Anything not listed
// falls back to its family icon (tool-families), then to a wrench.
const TOOL_ICON_OVERRIDES: Record<string, LucideIcon> = {
  sftp_read: FileText,
  sftp_write: FilePlus,
  sftp_delete: FileX,
  process_signal: Skull,
  docker_action: Play,
  docker_pull: UploadCloud,
  systemd_stop: CircleStop,
  systemd_start: Power,
  oss_put: UploadCloud,
  oss_delete: Trash2,
  k8s_delete: Trash2,
  firewall_set_enabled: ShieldAlert,
  session_terminate: CircleStop,
  sftp_list: FolderTree,
  audit_query: ScrollText,
}

export function toolIcon(name: string): LucideIcon {
  return TOOL_ICON_OVERRIDES[name] ?? toolFamily(name).icon
}

// DANGER_TOOLS mirrors the backend Danger=high set so the UI can flag high-risk
// calls (the gate is authoritative; this is purely a visual signal). Read tools
// are never listed.
export const DANGER_TOOLS: ReadonlySet<string> = new Set([
  // ssh / sftp / session / portforward (legacy)
  "ssh_exec",
  "sftp_write",
  "sftp_delete",
  "session_terminate",
  "portforward_create",
  "portforward_delete",
  // process
  "process_signal",
  "process_renice",
  // systemd
  "systemd_start",
  "systemd_stop",
  "systemd_restart",
  "systemd_reload",
  // kernel / storage
  "kernel_param_set",
  "storage_mount",
  "storage_unmount",
  // docker
  "docker_action",
  "docker_prune",
  "docker_pull",
  // k8s
  "k8s_scale",
  "k8s_apply",
  "k8s_delete",
  // network / firewall
  "net_set_iface",
  "firewall_add",
  "firewall_delete",
  "firewall_set_enabled",
  // packages
  "pkg_install",
  "pkg_remove",
  "pkg_upgrade",
  // cron / sysuser / secaudit
  "cron_add",
  "cron_remove",
  "cron_set_timer",
  "sysuser_lock",
  "sysuser_add_group",
  "secaudit_apply",
  // database / oss
  "db_exec",
  "db_kill",
  "oss_put",
  "oss_delete",
  "oss_copy",
])

export function isDangerName(name: string): boolean {
  return DANGER_TOOLS.has(name)
}

export { ShieldAlert }
