import { Database, FolderTree, Monitor, Network, Server, Share2, Terminal } from "lucide-react"
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

export const PROTOCOL_META: Record<Protocol, ProtocolMeta> = {
  ssh: {
    key: "ssh",
    label: "SSH 终端",
    icon: Terminal,
    tint: "text-emerald-500 dark:text-emerald-400",
    hrefSegment: "ssh",
    ws: true,
  },
  telnet: {
    key: "telnet",
    label: "Telnet 终端",
    icon: Terminal,
    tint: "text-amber-500 dark:text-amber-400",
    hrefSegment: "telnet",
    ws: true,
  },
  dbcli: {
    key: "dbcli",
    label: "数据库 CLI",
    icon: Database,
    tint: "text-violet-500 dark:text-violet-400",
    hrefSegment: "dbcli",
    ws: true,
  },
  rdp: {
    key: "rdp",
    label: "RDP 远程桌面",
    icon: Monitor,
    tint: "text-sky-500 dark:text-sky-400",
    hrefSegment: "rdp",
    ws: true,
  },
  rdp_next: {
    key: "rdp_next",
    label: "RDP (Beta · 新栈)",
    icon: Monitor,
    tint: "text-cyan-500 dark:text-cyan-400",
    hrefSegment: "rdp-next",
    ws: true,
  },
  vnc: {
    key: "vnc",
    label: "VNC 远程桌面",
    icon: Monitor,
    tint: "text-blue-500 dark:text-blue-400",
    hrefSegment: "vnc",
    ws: true,
  },
  sftp: {
    key: "sftp",
    label: "SFTP 文件管理",
    icon: FolderTree,
    tint: "text-orange-500 dark:text-orange-400",
    hrefSegment: "sftp",
    ws: false,
  },
  tcp_forward: {
    key: "tcp_forward",
    label: "端口转发",
    icon: Share2,
    tint: "text-pink-500 dark:text-pink-400",
    hrefSegment: "port-forwards",
    ws: false,
  },
}

// Default protocols available for a given node based on its declared
// protocol — mirrors `actionList()` in nodes/[id]/page.tsx but flatter.
const DB_PROTOS = new Set(["mysql", "postgres", "redis", "mongo"])

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
    default:
      if (DB_PROTOS.has(protocol)) return ["dbcli", "tcp_forward"]
      return ["tcp_forward"]
  }
}

export function protocolChoicesForNode(protocol: string): ProtocolChoice[] {
  const choices: ProtocolChoice[] = []
  for (const p of protocolsForNode(protocol)) {
    const meta = metaOf(p)
    if (p !== "rdp_next") {
      choices.push({ protocol: p, label: meta.label, value: p })
      continue
    }

    for (const rdpBackend of ["freerdp", "ironrdp"] as const) {
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
