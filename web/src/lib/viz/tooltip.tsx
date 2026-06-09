"use client"

import { TooltipWithBounds, useTooltip } from "@visx/tooltip"
import type { ReactNode } from "react"

export { useTooltip }

// VizTooltip overrides visx's default white/blue/shadowed tooltip with the warm
// popover token set (no shadow), so every chart's hover card matches the design
// system. Render it inside the chart's relatively-positioned wrapper.
export function VizTooltip({
  top,
  left,
  children,
}: {
  top: number
  left: number
  children: ReactNode
}) {
  return (
    <TooltipWithBounds
      top={top}
      left={left}
      // Inline styles win over visx defaultStyles; keep it to tokens.
      style={{
        position: "absolute",
        pointerEvents: "none",
        background: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        boxShadow: "none",
        padding: "8px 10px",
        fontSize: 12,
        lineHeight: 1.45,
        zIndex: 30,
      }}
    >
      {children}
    </TooltipWithBounds>
  )
}
