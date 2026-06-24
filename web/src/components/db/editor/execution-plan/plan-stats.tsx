"use client"

import type { PlanNode } from "@/lib/api/types"

// PlanStats rolls the plan tree up into an operator frequency table + the
// heaviest single node. The frequency view is the fastest way to spot a plan
// that does N sequential scans or sorts: those operators cluster at the top.
interface Props {
  root: PlanNode
}

export function PlanStats({ root }: Props) {
  const counts: Record<string, number> = {}
  let heaviest: PlanNode = root
  walk(root, (n) => {
    counts[n.Op] = (counts[n.Op] ?? 0) + 1
    if ((n.Cost ?? 0) > (heaviest.Cost ?? 0)) heaviest = n
  })
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return (
    <div className="p-2 space-y-3 text-xs">
      <div className="rounded border p-2">
        <div className="text-muted-foreground mb-0.5">最重节点</div>
        <div className="font-semibold">
          {heaviest.Op}
          {heaviest.Table ? ` · ${heaviest.Table}` : ""}
        </div>
        <div className="text-muted-foreground">
          cost={(heaviest.Cost ?? 0).toFixed(2)} · rows={heaviest.Rows ?? 0}
        </div>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1 font-medium">算子</th>
            <th className="py-1 font-medium text-right">次数</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([op, c]) => (
            <tr key={op} className="border-b last:border-b-0">
              <td className="py-1">{op}</td>
              <td className="py-1 text-right tabular-nums">{c}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function walk(n: PlanNode, fn: (n: PlanNode) => void) {
  fn(n)
  for (const c of n.Children ?? []) walk(c, fn)
}
