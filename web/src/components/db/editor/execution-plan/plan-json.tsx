"use client"

import type { PlanNode } from "@/lib/api/types"

// PlanJson dumps the normalised tree as indented JSON. Useful for copy-pasting
// a plan into a bug report or comparing two runs with a diff tool. When the
// planner returned no tree (e.g. an engine that only exposes raw text), it
// renders an honest empty state instead of the string "null".
export function PlanJson({ root }: { root: PlanNode | null }) {
  if (!root) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground p-4">
        没有结构化计划（仅文本）
      </div>
    )
  }
  return (
    <pre className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap p-2">
      {JSON.stringify(root, null, 2)}
    </pre>
  )
}
