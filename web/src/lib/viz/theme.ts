// Shared visx palette + scales drawn from the design-system CSS variables, so
// every lifecycle chart stays inside the warm token set (coral is the only
// accent; red is reserved for abnormal dots/strokes; no shadows). visx accepts
// `var(--x)` strings directly, so we never resolve the values in JS.

import type { SessionKind, SessionPhaseKind } from "@/lib/api/types"

export const VIZ = {
  axis: "var(--border)",
  tick: "var(--muted-foreground)",
  grid: "var(--border)",
  coral: "var(--chart-1)", // primary series / selected
  teal: "var(--chart-2)", // RTT, secondary
  amber: "var(--chart-3)", // loss / attention
  green: "var(--chart-4)",
  neutral: "var(--chart-5)",
  danger: "var(--destructive)", // dots / strokes only
  card: "var(--card)",
} as const

export type VizAccent = "neutral" | "amber" | "teal" | "coral" | "green" | "danger"

export const ACCENT_FILL: Record<VizAccent, string> = {
  neutral: VIZ.neutral,
  amber: VIZ.amber,
  teal: VIZ.teal,
  coral: VIZ.coral,
  green: VIZ.green,
  danger: VIZ.danger,
}

// Per-kind swimlane / bar fill. Reuses the chart ramp; coral stays the
// interactive-terminal signature so it reads as "primary".
export const KIND_FILL: Record<SessionKind, string> = {
  interactive: VIZ.coral,
  graphical: VIZ.teal,
  sftp: VIZ.amber,
  oss: VIZ.neutral,
  tcp_forward: VIZ.green,
  anonymous: VIZ.danger,
}

// Per-phase bar fill for the lifecycle gantt.
export const PHASE_FILL: Record<SessionPhaseKind, string> = {
  dial: VIZ.neutral,
  auth: VIZ.amber,
  handshake: VIZ.teal,
  ready: VIZ.coral,
  reconnect: VIZ.amber,
  closed: VIZ.neutral,
}
