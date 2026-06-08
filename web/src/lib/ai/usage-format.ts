// Shared token/cost formatting + the chart colour ramp for every AI usage
// surface (the global usage page + the per-provider usage panel).

export const MODEL_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return `${n}`
}

export function fmtCost(micros: number): string {
  const usd = micros / 1_000_000
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

// fmtPrice renders a per-1M-token USD rate compactly (for model pricing cells).
export function fmtPrice(perMtok?: number): string {
  if (!perMtok || perMtok <= 0) return "—"
  if (perMtok >= 1) return `$${perMtok.toFixed(2)}`
  return `$${perMtok.toFixed(3)}`
}
