import {
  Activity,
  FileText,
  FilePlus,
  FileX,
  FolderTree,
  Network,
  PlayCircle,
  ScrollText,
  Server,
  ShieldAlert,
  StopCircle,
  Terminal,
  TerminalSquare,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react"

export const TOOL_ICONS: Record<string, LucideIcon> = {
  ssh_exec: Terminal,
  ssh_exec_readonly: TerminalSquare,
  sftp_list: FolderTree,
  sftp_read: FileText,
  sftp_write: FilePlus,
  sftp_delete: FileX,
  health_check: Activity,
  list_nodes: Server,
  get_node: Server,
  session_list: PlayCircle,
  session_terminate: StopCircle,
  audit_query: ScrollText,
  portforward_create: Network,
  portforward_delete: Network,
  call_subagent: Users,
}

export function toolIcon(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? Wrench
}

export const DANGER_TOOLS: ReadonlySet<string> = new Set([
  "ssh_exec",
  "sftp_write",
  "sftp_delete",
  "session_terminate",
  "portforward_create",
  "portforward_delete",
])

export function isDangerName(name: string): boolean {
  return DANGER_TOOLS.has(name)
}

export { ShieldAlert }
