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

// Dot fill classes — used for the small status dots on tabs / status bar.
export const STATUS_DOT: Record<TabStatus, string> = {
  fresh: "bg-muted-foreground/40",
  connecting: "bg-[#d4a017] dark:bg-[#e3b84e]",
  connected: "bg-[#5db872]",
  closed: "bg-muted-foreground/40",
  error: "bg-destructive",
  approval: "bg-[#d4a017] dark:bg-[#e3b84e]",
}

// Text classes — labels / counts that carry the status tone.
export const STATUS_TEXT: Record<TabStatus, string> = {
  fresh: "text-muted-foreground",
  connecting: "text-[#c08a2e] dark:text-[#e3b84e]",
  connected: "text-[#4c9b62] dark:text-[#5db872]",
  closed: "text-muted-foreground",
  error: "text-destructive",
  approval: "text-[#c08a2e] dark:text-[#e3b84e]",
}

// Latency tone — same thresholds the desktop status bar uses, in warm tokens:
// ≤80 sage · ≤200 amber · ≤500 warm-orange · >500 destructive · null muted.
export function latencyTone(ms: number | null): string {
  if (ms == null) return "text-muted-foreground/60"
  if (ms <= 80) return "text-[#4c9b62] dark:text-[#5db872]"
  if (ms <= 200) return "text-[#c08a2e] dark:text-[#e3b84e]"
  if (ms <= 500) return "text-[#bf6f33] dark:text-[#e8a55a]"
  return "text-destructive"
}
