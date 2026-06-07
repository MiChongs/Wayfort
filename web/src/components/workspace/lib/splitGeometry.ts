import type * as React from "react"

// Split layouts the content area supports.
//   single  → one pane, full bleed
//   row-2   → two panes side by side   (draggable vertical divider)
//   col-2   → two panes stacked        (draggable horizontal divider)
//   row-3   → three equal columns
//   col-3   → three equal rows
//   grid-4  → 2×2 grid
export type SplitLayout = "single" | "row-2" | "col-2" | "row-3" | "col-3" | "grid-4"

// Per-tab pane assignment. `slots[i]` is the tabId shown in pane i (or null if
// that grid cell's tab was closed). slots[0] mirrors the active tab.
export type SplitState = {
  layout: SplitLayout
  slots: (string | null)[]
  // Primary pane fraction (0.2–0.8) — only the two-pane layouts use it; 3-up
  // and 2×2 divide equally.
  ratio: number
}

export const SLOT_COUNT: Record<SplitLayout, number> = {
  single: 1,
  "row-2": 2,
  "col-2": 2,
  "row-3": 3,
  "col-3": 3,
  "grid-4": 4,
}

export const FULL_RECT: React.CSSProperties = { left: 0, top: 0, right: 0, bottom: 0 }

const pct = (n: number) => `${n * 100}%`

// rectForSlot positions pane `idx` of `layout`. Pure function — the content
// renderer maps each slot to a rect without remounting any session, so canvas
// keepalive is preserved across layout changes.
export function rectForSlot(layout: SplitLayout, idx: number, ratio: number): React.CSSProperties {
  switch (layout) {
    case "single":
      return FULL_RECT
    case "row-2":
      return idx === 0
        ? { left: 0, top: 0, width: pct(ratio), height: "100%" }
        : { left: pct(ratio), top: 0, width: pct(1 - ratio), height: "100%" }
    case "col-2":
      return idx === 0
        ? { left: 0, top: 0, width: "100%", height: pct(ratio) }
        : { left: 0, top: pct(ratio), width: "100%", height: pct(1 - ratio) }
    case "row-3":
      return { left: pct(idx / 3), top: 0, width: pct(1 / 3), height: "100%" }
    case "col-3":
      return { left: 0, top: pct(idx / 3), width: "100%", height: pct(1 / 3) }
    case "grid-4":
      return {
        left: pct((idx % 2) / 2),
        top: pct(Math.floor(idx / 2) / 2),
        width: "50%",
        height: "50%",
      }
  }
}

// Only the two-pane layouts get a draggable divider; 3-up / 2×2 are equal
// divisions (keeps the pointer math and the regression surface small).
export function isDraggableSplit(layout: SplitLayout): boolean {
  return layout === "row-2" || layout === "col-2"
}
