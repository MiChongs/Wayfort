// Group color tokens shared between WorkspaceTab and GroupHeader. Kept in
// a dedicated file so both visual components emit the same Tailwind class
// strings — keep this in sync with `GroupColor` in useWorkspaceStore.ts.

import type { GroupColor } from "./useWorkspaceStore"

// Solid-ish backgrounds used as the bottom accent strip beneath a tab.
export const GROUP_ACCENT_BG: Record<GroupColor, string> = {
  gray: "bg-slate-400/80 dark:bg-slate-500/80",
  blue: "bg-blue-500/80 dark:bg-blue-400/80",
  red: "bg-rose-500/80 dark:bg-rose-400/80",
  yellow: "bg-amber-400/80 dark:bg-amber-300/80",
  green: "bg-emerald-500/80 dark:bg-emerald-400/80",
  cyan: "bg-cyan-500/80 dark:bg-cyan-400/80",
  purple: "bg-violet-500/80 dark:bg-violet-400/80",
  orange: "bg-orange-500/80 dark:bg-orange-400/80",
}

// Pill backgrounds for GroupHeader chips. Lighter than the accent stripe
// so the header reads as a label, not a tab.
export const GROUP_PILL_BG: Record<GroupColor, string> = {
  gray: "bg-slate-200/60 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200",
  blue: "bg-blue-100/80 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  red: "bg-rose-100/80 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
  yellow: "bg-amber-100/80 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  green: "bg-emerald-100/80 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
  cyan: "bg-cyan-100/80 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200",
  purple: "bg-violet-100/80 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
  orange: "bg-orange-100/80 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200",
}

// Small swatch used in the picker grid + ContextMenu submenu indicators.
export const GROUP_SWATCH_BG: Record<GroupColor, string> = {
  gray: "bg-slate-400",
  blue: "bg-blue-500",
  red: "bg-rose-500",
  yellow: "bg-amber-400",
  green: "bg-emerald-500",
  cyan: "bg-cyan-500",
  purple: "bg-violet-500",
  orange: "bg-orange-500",
}

export const GROUP_COLOR_NAME: Record<GroupColor, string> = {
  gray: "灰",
  blue: "蓝",
  red: "红",
  yellow: "黄",
  green: "绿",
  cyan: "青",
  purple: "紫",
  orange: "橙",
}
