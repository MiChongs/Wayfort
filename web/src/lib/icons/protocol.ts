// The ONE protocol → icon-token map. Replaces the three hand-copied
// PROTOCOL_ICON / protoIcon definitions that used to live in admin/nodes,
// nodes, and nodes/[id]. Brand-aware: real engines get their Simple Icons
// glyph; everything else falls back to a clean Lucide line icon.

import type { NodeProtocol } from "@/lib/api/types"

export const PROTOCOL_ICON_TOKEN: Partial<Record<NodeProtocol, string>> = {
  ssh: "lucide:terminal",
  telnet: "lucide:terminal",
  rdp: "lucide:monitor",
  vnc: "lucide:monitor",
  tcp: "lucide:network",

  mysql: "simple:mysql",
  postgres: "simple:postgresql",
  redis: "simple:redis",
  mongo: "simple:mongodb",

  // Object storage — neutral cloud glyph (per-node icon can override with an
  // Aliyun/Tencent/AWS brand mark via the icon picker).
  oss: "lucide:cloud",

  // Phase 22+ 国产 / 兼容数据库 — no dedicated brand glyph, use a clean DB icon.
  dameng: "lucide:database",
  kingbase: "lucide:database",
  vastbase: "lucide:database",
  highgo: "lucide:database",
  opengauss: "lucide:database",
  gaussdb: "lucide:database",
  tidb: "lucide:database",
  oceanbase: "lucide:database",
  starrocks: "lucide:database",
  doris: "lucide:database",
  gbase8a: "lucide:database",
  gbase8s: "lucide:database",
}

// protocolIconToken returns a token for a protocol, defaulting to a database
// glyph for unknown/DB-shaped protocols.
export function protocolIconToken(protocol?: string | null): string {
  if (!protocol) return "lucide:server"
  return PROTOCOL_ICON_TOKEN[protocol as NodeProtocol] ?? "lucide:database"
}

// nodeIcon resolves a node's effective icon token: the user's explicit override
// if set, else the protocol default.
export function nodeIcon(node?: { icon?: string | null; protocol?: string | null }): string {
  const explicit = node?.icon?.trim()
  if (explicit) return explicit
  return protocolIconToken(node?.protocol)
}
