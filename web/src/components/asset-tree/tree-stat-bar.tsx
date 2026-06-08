"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

// A compact stats strip above an asset tree: total / matched / selected. The
// `right` slot carries view controls (expand-all, …).
export function TreeStatBar({
  total,
  matched,
  selected,
  right,
  className,
}: {
  total: number
  matched?: number
  selected?: number
  right?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-3 px-1 py-1.5 text-xs text-muted-foreground", className)}>
      <span className="tabular-nums">
        共 <span className="font-medium text-foreground">{total}</span> 项
      </span>
      {matched != null && matched !== total && (
        <span className="tabular-nums">匹配 {matched}</span>
      )}
      {selected != null && selected > 0 && (
        <span className="tabular-nums text-primary">已选 {selected}</span>
      )}
      {right ? <div className="ml-auto flex items-center gap-1">{right}</div> : null}
    </div>
  )
}
