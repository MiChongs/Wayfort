import {
  Activity,
  Boxes,
  CalendarClock,
  CircuitBoard,
  Cloud,
  Container,
  Cpu,
  Database,
  FolderTree,
  Gauge,
  HardDrive,
  MessageCircleQuestion,
  Network,
  Package,
  ScrollText,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  UserCheck,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react"

export interface ToolFamily {
  key: string
  label: string
  icon: LucideIcon
}

// Canonical tool families. `match` decides membership from the tool name; the
// list is ordered so the first match wins (specific exact-name sets precede
// broad prefixes). Shared by tool-icons (fallback icon) and the agent-form tool
// multiselect (grouping).
interface FamilyDef extends ToolFamily {
  match: (name: string) => boolean
}

const pre = (...ps: string[]) => (n: string) => ps.some((p) => n.startsWith(p))
const exact = (...ns: string[]) => (n: string) => ns.includes(n)

const FAMILIES: FamilyDef[] = [
  { key: "node", label: "节点", icon: Server, match: exact("list_nodes", "get_node", "node_test", "health_check") },
  { key: "ssh", label: "SSH 执行", icon: Terminal, match: pre("ssh_exec") },
  { key: "sftp", label: "文件 (SFTP)", icon: FolderTree, match: pre("sftp_") },
  { key: "process", label: "进程", icon: Activity, match: pre("process_") },
  { key: "systemd", label: "服务 (systemd)", icon: Settings2, match: pre("systemd_") },
  { key: "perf", label: "性能", icon: Gauge, match: pre("perf_") },
  { key: "logs", label: "日志", icon: ScrollText, match: pre("logs_") },
  { key: "docker", label: "容器 (Docker)", icon: Container, match: pre("docker_") },
  { key: "k8s", label: "Kubernetes", icon: Boxes, match: pre("k8s_") },
  { key: "network", label: "网络", icon: Network, match: pre("net_") },
  { key: "firewall", label: "防火墙", icon: ShieldAlert, match: pre("firewall_") },
  { key: "pkg", label: "软件包", icon: Package, match: pre("pkg_") },
  { key: "cron", label: "定时任务", icon: CalendarClock, match: pre("cron_") },
  { key: "sysuser", label: "系统用户", icon: Users, match: pre("sysuser_") },
  { key: "secaudit", label: "安全审计", icon: ShieldCheck, match: pre("secaudit_") },
  { key: "storage", label: "存储", icon: HardDrive, match: pre("storage_") },
  { key: "kernel", label: "内核", icon: Cpu, match: pre("kernel_") },
  { key: "hardware", label: "硬件", icon: CircuitBoard, match: pre("hardware_") },
  { key: "db", label: "数据库", icon: Database, match: pre("db_") },
  { key: "oss", label: "对象存储", icon: Cloud, match: pre("oss_") },
  { key: "session", label: "会话 / 审计", icon: ScrollText, match: exact("session_list", "session_terminate", "audit_query") },
  { key: "portforward", label: "端口转发", icon: Network, match: pre("portforward_") },
  { key: "identity", label: "身份", icon: UserCheck, match: exact("whoami_audit", "login_history_query", "anomaly_list") },
  { key: "subagent", label: "编排", icon: Users, match: exact("call_subagent") },
  { key: "interactive", label: "交互", icon: MessageCircleQuestion, match: exact("ask_user", "exit_plan_mode", "update_plan") },
]

const OTHER: ToolFamily = { key: "other", label: "其它", icon: Wrench }

export function toolFamily(name: string): ToolFamily {
  const f = FAMILIES.find((fam) => fam.match(name))
  return f ?? OTHER
}

/** Ordered family list (key + label + icon only) for grouped UIs. */
export const TOOL_FAMILY_ORDER: ToolFamily[] = FAMILIES.map(({ key, label, icon }) => ({ key, label, icon }))

/** Group tool names by family, preserving family order; drops empty families. */
export function groupToolsByFamily<T extends { name: string }>(
  tools: T[],
): { family: ToolFamily; tools: T[] }[] {
  const buckets = new Map<string, T[]>()
  for (const t of tools) {
    const k = toolFamily(t.name).key
    const arr = buckets.get(k) ?? []
    arr.push(t)
    buckets.set(k, arr)
  }
  const out: { family: ToolFamily; tools: T[] }[] = []
  for (const fam of [...TOOL_FAMILY_ORDER, OTHER]) {
    const arr = buckets.get(fam.key)
    if (arr && arr.length) out.push({ family: fam, tools: arr })
  }
  return out
}
