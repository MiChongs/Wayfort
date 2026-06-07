import type { Protocol } from "../useWorkspaceStore"

// Maps the short prefixes a user might type in the launcher to a canonical
// protocol family. "db" / "rdp" resolve to whichever concrete protocol the
// target node actually supports (see resolveChoice in NewTabLauncher).
const PREFIX_ALIASES: Record<string, string> = {
  ssh: "ssh",
  telnet: "telnet",
  rdp: "rdp",
  desktop: "rdp",
  vnc: "vnc",
  sftp: "sftp",
  file: "sftp",
  files: "sftp",
  db: "db",
  database: "db",
  sql: "db",
  oss: "oss",
  tcp: "tcp_forward",
  forward: "tcp_forward",
}

export type ConnectCommand = { prefix: string; host: string }

// Parse a "proto:host" quick-connect command (half- or full-width colon).
// Returns null when the input isn't in that shape or the prefix is unknown, so
// the launcher falls back to ordinary fuzzy search.
export function parseConnectCommand(input: string): ConnectCommand | null {
  const m = input.trim().match(/^([a-zA-Z_]+)\s*[:：]\s*(.+)$/)
  if (!m) return null
  const prefix = PREFIX_ALIASES[m[1].toLowerCase()]
  if (!prefix) return null
  const host = m[2].trim()
  if (!host) return null
  return { prefix, host }
}

// Given the parsed prefix and a node's available protocol values, pick the
// concrete protocol to open. "db"/"rdp" prefer the richer variant.
export function matchProtocol(prefix: string, available: Protocol[]): Protocol | undefined {
  if (prefix === "db") {
    return (
      available.find((p) => p === "dbcli") ?? available.find((p) => p === "db_studio")
    )
  }
  if (prefix === "rdp") {
    return available.find((p) => p === "rdp_next") ?? available.find((p) => p === "rdp")
  }
  return available.find((p) => p === prefix)
}
