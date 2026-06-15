// Client-side classifier that turns a raw WebSocket / guacd / SSH
// disconnect reason string into a structured shape the UI can render.
//
// Patterns were collected from the actual strings we've observed on
// Windows + Linux: winsock `connectex` errors, Node-style `ECONN*`
// codes, OpenSSH `auth fail` / `publickey` messages, WebSocket close
// codes 1000/1001 ("Going Away" / "Normal Closure"), and our own
// guacd dial errors.
//
// Order matters — the table is read top-to-bottom and the first
// matching rule wins. Specific patterns (e.g. `connectex:.*no
// connection`) precede generic ones (`timeout`) so users see the most
// informative category.
//
// The cleaner long-term design is to bump the WebSocket protocol so
// the backend emits a structured close frame `{ code, raw }`. That
// removes the brittleness of string matching and is the path forward
// once the protocol revision lands. Until then this module is the
// translation layer.

export type DisconnectCategory =
  | "networkUnreachable"
  | "networkFlap"
  | "authFailed"
  | "serverClosed"
  | "timeout"
  | "agentUnavailable"
  | "unknown"

export type DisconnectSuggestion =
  | "checkNode"
  | "checkCredentials"
  | "retry"
  | "checkAgent"
  | "contactAdmin"

export interface DisconnectInfo {
  /** Coarse-grained category for choosing the i18n message and color. */
  category: DisconnectCategory
  /** Action label the toast offers (mapped to i18n suggestion.*). */
  suggestion: DisconnectSuggestion
  /** Where the suggestion link goes; absent for non-actionable cases. */
  href?: string
  /** Original raw string from the backend / browser, for diagnostics. */
  raw: string
}

interface Rule {
  pattern: RegExp
  category: DisconnectCategory
  suggestion: DisconnectSuggestion
  href?: string
}

const RULES: ReadonlyArray<Rule> = [
  // Agent-domain asset with no reverse-connect agent online — backend emits the
  // machine-readable token `agent_unavailable` as the close reason (gateway.go
  // closeForError). Most specific; keep at the top.
  { pattern: /agent_unavailable/i, category: "agentUnavailable", suggestion: "checkAgent", href: "/admin/domains" },
  // Windows winsock — most specific, must come before generic timeout.
  { pattern: /connectex:\s*no connection/i, category: "networkUnreachable", suggestion: "checkNode", href: "/admin/nodes" },
  { pattern: /ECONNREFUSED|connection refused/i, category: "networkUnreachable", suggestion: "checkNode", href: "/admin/nodes" },
  { pattern: /no route to host|EHOSTUNREACH|ENETUNREACH/i, category: "networkUnreachable", suggestion: "checkNode", href: "/admin/nodes" },
  { pattern: /ECONNRESET|connection reset/i, category: "networkFlap", suggestion: "retry" },
  { pattern: /authentication fail|auth fail|permission denied|publickey/i, category: "authFailed", suggestion: "checkCredentials", href: "/admin/credentials" },
  { pattern: /timeout|ETIMEDOUT/i, category: "timeout", suggestion: "retry" },
  // WebSocket clean-close codes — server-initiated, retry usually works.
  { pattern: /going away|normal closure|\b1000\b|\b1001\b/i, category: "serverClosed", suggestion: "retry" },
]

/**
 * Classify a raw disconnect string into a `DisconnectInfo`. Unmatched
 * inputs return the `unknown` category so the UI can surface "I don't
 * recognize this error" explicitly instead of swallowing it.
 */
export function inferDisconnect(raw: string | null | undefined): DisconnectInfo {
  const r = (raw ?? "").trim()
  for (const rule of RULES) {
    if (rule.pattern.test(r)) {
      return {
        category: rule.category,
        suggestion: rule.suggestion,
        href: rule.href,
        raw: r,
      }
    }
  }
  return { category: "unknown", suggestion: "contactAdmin", raw: r }
}
