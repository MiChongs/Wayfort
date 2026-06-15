import { Cloud, Database, FolderTree, Monitor, Network, Server, Share2, Table, Terminal } from "lucide-react"
import type { Protocol } from "./useWorkspaceStore"
import type { ComponentType } from "react"
import type { DesktopBackend } from "@/lib/desktop/types"

export type ProtocolMeta = {
  key: Protocol
  label: string
  icon: ComponentType<{ className?: string }>
  tint: string
  // What URL fragment this protocol maps to under /nodes/:id/<frag>. Used
  // when "Open in new browser tab" is requested from the context menu.
  hrefSegment: string
  // Whether the protocol opens a long-lived WebSocket. Affects whether the
  // status indicator on the tab cycles through fresh→connecting→connected
  // or stays at connected (REST-based).
  ws: boolean
}

export type ProtocolChoice = {
  protocol: Protocol
  rdpBackend?: DesktopBackend
  label: string
  description?: string
  value: string
}

export const RDP_BACKEND_META: Record<DesktopBackend, { label: string; shortLabel: string; description: string }> = {
  freerdp: {
    label: "FreeRDP",
    shortLabel: "FreeRDP",
    description: "后端 freerdp-worker 转码，适合审计、录制和网关侧控制。",
  },
  ironrdp: {
    label: "IronRDP",
    shortLabel: "IronRDP",
    description: "浏览器 Wasm RDP 客户端，经 Devolutions Gateway 连接。",
  },
  dummy: {
    label: "Dummy 测试栈",
    shortLabel: "Dummy",
    description: "测试图案 worker，仅用于调试链路。",
  },
}

// Warm protocol tints — collapsed from the old rainbow onto the design system's
// warm accent families so the workspace reads cohesive, not IDE-like:
//   terminals → teal · databases → amber · desktops → coral · files → sage ·
//   utility → muted. Icon shape still carries the fine-grained recognition.
const TINT_TERMINAL = "text-[#4f9d8f] dark:text-[#5db8a6]"
const TINT_DB = "text-[#bf6f33] dark:text-[#e8a55a]"
const TINT_DESKTOP = "text-primary"
const TINT_FILE = "text-[#4c9b62] dark:text-[#5db872]"
const TINT_UTIL = "text-muted-foreground"

export const PROTOCOL_META: Record<Protocol, ProtocolMeta> = {
  ssh: {
    key: "ssh",
    label: "SSH 终端",
    icon: Terminal,
    tint: TINT_TERMINAL,
    hrefSegment: "ssh",
    ws: true,
  },
  telnet: {
    key: "telnet",
    label: "Telnet 终端",
    icon: Terminal,
    tint: TINT_TERMINAL,
    hrefSegment: "telnet",
    ws: true,
  },
  dbcli: {
    key: "dbcli",
    label: "数据库 CLI",
    icon: Database,
    tint: TINT_DB,
    hrefSegment: "dbcli",
    ws: true,
  },
  db_studio: {
    key: "db_studio",
    label: "数据库浏览",
    icon: Table,
    tint: TINT_DB,
    hrefSegment: "db",
    ws: false,
  },
  rdp: {
    key: "rdp",
    label: "RDP 远程桌面",
    icon: Monitor,
    tint: TINT_DESKTOP,
    hrefSegment: "rdp",
    ws: true,
  },
  rdp_next: {
    key: "rdp_next",
    label: "RDP (Beta · 新栈)",
    icon: Monitor,
    tint: TINT_DESKTOP,
    hrefSegment: "rdp-next",
    ws: true,
  },
  vnc: {
    key: "vnc",
    label: "VNC 远程桌面",
    icon: Monitor,
    tint: TINT_DESKTOP,
    hrefSegment: "vnc",
    ws: true,
  },
  sftp: {
    key: "sftp",
    label: "SFTP 文件管理",
    icon: FolderTree,
    tint: TINT_FILE,
    hrefSegment: "sftp",
    ws: false,
  },
  oss: {
    key: "oss",
    label: "对象存储",
    icon: Cloud,
    tint: TINT_FILE,
    hrefSegment: "oss",
    ws: false,
  },
  tcp_forward: {
    key: "tcp_forward",
    label: "端口转发",
    icon: Share2,
    tint: TINT_UTIL,
    hrefSegment: "port-forwards",
    ws: false,
  },
}

// Phase 22+ — every protocol the dbquery plugin registry knows about
// at compile time. The legacy mysql/postgres + Chinese DBs all route
// to the same workspace actions (DB Studio for relational; dbcli for
// terminal). The runtime engine catalogue (/api/v1/db/engines) is the
// authoritative source; this set is only the static fallback for
// nodes whose protocol the front-end recognises ahead of a roundtrip.
const RELATIONAL_DB_PROTOS = new Set([
  "mysql", "postgres",
  // PG-family
  "kingbase", "vastbase", "highgo", "opengauss", "gaussdb", "gbase8s",
  // MySQL-family
  "tidb", "oceanbase", "starrocks", "doris", "gbase8a",
  // Oracle-family (Dameng)
  "dameng",
])

// CLI-only DB protocols — schema-free / key-value stores stay on the
// terminal flow until a structured Studio tab supports them.
const CLI_ONLY_DB_PROTOS = new Set(["redis", "mongo"])

export function protocolsForNode(protocol: string): Protocol[] {
  switch (protocol) {
    case "ssh":
      return ["ssh", "sftp", "tcp_forward"]
    case "telnet":
      return ["telnet", "tcp_forward"]
    case "rdp":
      return ["rdp", "rdp_next", "tcp_forward"]
    case "vnc":
      return ["vnc", "tcp_forward"]
    case "tcp":
      return ["sftp", "tcp_forward"]
    case "oss":
      return ["oss"]
    default:
      if (RELATIONAL_DB_PROTOS.has(protocol)) {
        // Relational DBs (vanilla + every Chinese DB) get DB Studio
        // first, terminal CLI second, port forward last.
        return ["db_studio", "dbcli", "tcp_forward"]
      }
      if (CLI_ONLY_DB_PROTOS.has(protocol)) {
        return ["dbcli", "tcp_forward"]
      }
      return ["tcp_forward"]
  }
}

export function protocolChoicesForNode(protocol: string, preferredRdp?: DesktopBackend): ProtocolChoice[] {
  const choices: ProtocolChoice[] = []
  // Order RDP backends so the one the server can actually serve right now
  // (preferredRdp, resolved from /desktop/stats) is first → it becomes the
  // default double-click / drag-open choice. Without a preference we keep the
  // historical order (freerdp first). This prevents defaulting to a backend the
  // host can't serve (e.g. freerdp with no worker built) while the other path
  // (Devolutions Gateway / ironrdp) is healthy — the "no session" symptom.
  const rdpBackends: DesktopBackend[] =
    preferredRdp === "ironrdp" ? ["ironrdp", "freerdp"] : ["freerdp", "ironrdp"]
  for (const p of protocolsForNode(protocol)) {
    const meta = metaOf(p)
    if (p !== "rdp_next") {
      choices.push({ protocol: p, label: meta.label, value: p })
      continue
    }

    for (const rdpBackend of rdpBackends) {
      choices.push({
        protocol: p,
        rdpBackend,
        label: `${meta.label} · ${RDP_BACKEND_META[rdpBackend].label}`,
        description: RDP_BACKEND_META[rdpBackend].description,
        value: `${p}:${rdpBackend}`,
      })
    }
  }
  return choices
}

export function rdpBackendShortLabel(backend: DesktopBackend | undefined): string | null {
  if (!backend) return null
  return RDP_BACKEND_META[backend]?.shortLabel ?? backend
}

// Convenience reverse helpers
export function metaOf(p: Protocol): ProtocolMeta {
  return PROTOCOL_META[p]
}

// Network is exported for the StatusBar's audit icon row; placed here so the
// status bar doesn't need its own lucide import bundle.
export { Network, Server }
