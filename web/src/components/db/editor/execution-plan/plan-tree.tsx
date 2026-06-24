"use client"

import type { PlanNode } from "@/lib/api/types"

// PlanTree renders the normalised plan tree recursively. Cost is heat-mapped
// against the tree's total cost so the eye lands on the expensive nodes:
//   >= 20% of total → red    (likely the bottleneck)
//   >= 10% of total → amber
//   else            → plain
//
// The tree is built from <ul>/<li> so indentation + the left border read as a
// real outline (the plan snippet's nested <span> wrapper produced invalid DOM).
interface Props {
  root: PlanNode
}

export function PlanTree({ root }: Props) {
  const total = sumCost(root)
  return (
    <ul className="text-xs p-2 m-0 list-none">
      <PlanNodeRow node={root} total={total} />
    </ul>
  )
}

function PlanNodeRow({ node, total }: { node: PlanNode; total: number }) {
  const cost = node.Cost ?? 0
  const pct = total > 0 ? (cost / total) * 100 : 0
  const heat =
    pct >= 20 ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
    : pct >= 10 ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
    : ""
  const kids = node.Children ?? []
  return (
    <li className="m-0">
      <div className={`inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1.5 py-0.5 rounded ${heat}`}>
        <span className="font-semibold">{node.Op}</span>
        {node.Table && <span className="text-muted-foreground">{node.Table}</span>}
        <span className="text-muted-foreground">rows={node.Rows ?? 0}</span>
        <span className="text-muted-foreground">cost={cost.toFixed(2)} ({pct.toFixed(0)}%)</span>
        {node.Width != null && <span className="text-muted-foreground">w={node.Width}</span>}
      </div>
      {kids.length > 0 && (
        <ul className="border-l border-border/60 ml-2 pl-3 m-0 list-none">
          {kids.map((c, i) => (
            <PlanNodeRow key={`${c.Op}-${i}`} node={c} total={total} />
          ))}
        </ul>
      )}
    </li>
  )
}

// sumCost totals every node's cost so each node's share is a percentage of the
// whole tree (a rough proxy — DB cost models aren't strictly additive, but the
// ratio still ranks nodes the way an operator scans a plan).
function sumCost(n: PlanNode): number {
  let s = n.Cost ?? 0
  for (const c of n.Children ?? []) s += sumCost(c)
  return s
}
