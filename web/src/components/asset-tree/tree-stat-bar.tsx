"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { StatusDot } from "@/components/asset-tree/status-dot"

// A compact stats strip above an asset tree: total / matched / online (annotated
// with how many were actually probed, so the count never over-claims) / selected.
// The `right` slot carries view controls (expand-all, refresh, …).
export function TreeStatBar({
  total,
  matched,
  online,
  probed,
  selected,
  right,
  className,
}: {
  total: number
  matched?: number
  online?: number
  probed?: number
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
      {probed != null && probed > 0 && (
        <span className="inline-flex items-center gap-1 tabular-nums">
          <StatusDot state="online" pulse={false} />
          在线 {online ?? 0}
          <span className="text-muted-foreground/70">/ 已探测 {probed}</span>
        </span>
      )}
      {selected != null && selected > 0 && (
        <span className="tabular-nums text-primary">已选 {selected}</span>
      )}
      {right ? <div className="ml-auto flex items-center gap-1">{right}</div> : null}
    </div>
  )
}
