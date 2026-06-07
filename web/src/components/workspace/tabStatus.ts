// Warm status palette for the workspace chrome. One source of truth so a tab's
// status reads identically on the strip, the status bar, and hover previews —
// and so the whole workspace speaks the design system's warm tones (sage /
// amber / coral / destructive) instead of raw Tailwind emerald/sky/orange.
//
// connected → sage(#5db872) · connecting/approval → amber(#d4a017) ·
// error → destructive · fresh/closed → muted.

import type { TabStatus } from "./useWorkspaceStore"

export const STATUS_LABEL: Record<TabStatus, string> = {
  fresh: "未连接",
  connecting: "连接中",
  connected: "已连接",
  closed: "已关闭",
  error: "连接错误",
  approval: "待审批",
}

// Dot fill classes — semantic design tokens (success/warning/destructive carry
// their own light/dark values from globals.css, so no dark: variant needed).
export const STATUS_DOT: Record<TabStatus, string> = {
  fresh: "bg-muted-foreground/40",
  connecting: "bg-warning",
  connected: "bg-success",
  closed: "bg-muted-foreground/40",
  error: "bg-destructive",
  approval: "bg-warning",
}

// Text classes — labels / counts that carry the status tone.
export const STATUS_TEXT: Record<TabStatus, string> = {
  fresh: "text-muted-foreground",
  connecting: "text-warning",
  connected: "text-success",
  closed: "text-muted-foreground",
  error: "text-destructive",
  approval: "text-warning",
}

// Latency tone — warm semantic tokens: ≤80 sage · ≤200/≤500 amber · >500
// destructive · null muted.
export function latencyTone(ms: number | null): string {
  if (ms == null) return "text-muted-foreground/60"
  if (ms <= 80) return "text-success"
  if (ms <= 500) return "text-warning"
  return "text-destructive"
}
