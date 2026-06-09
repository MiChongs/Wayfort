"use client"

import { VIZ } from "./theme"

// AbnormalDot is the shared "something went wrong here" marker: a translucent
// halo + a solid core ringed by the card colour so it reads on any background.
// Mirrors the audit-overview marker so abnormal accents are identical
// everywhere. Render inside an <svg>/<g>.
export function AbnormalDot({ cx, cy, r = 2.75 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r + 3.25} fill={VIZ.danger} opacity={0.16} />
      <circle cx={cx} cy={cy} r={r} fill={VIZ.danger} stroke={VIZ.card} strokeWidth={1} />
    </g>
  )
}
