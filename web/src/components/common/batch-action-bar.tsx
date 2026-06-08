"use client"

import * as React from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// A slim, warm selection bar that floats at the top of a tree/list when one or
// more rows are selected. It owns only the chrome (count + clear + a divider);
// callers drop their own action triggers as children, so the same bar serves
// node trees (authorize / group / tag / enable / export) and group/org trees
// (move / delete).
export function BatchActionBar({
  count,
  onClear,
  children,
  noun = "项",
  className,
}: {
  count: number
  onClear: () => void
  children?: React.ReactNode
  noun?: string
  className?: string
}) {
  if (count <= 0) return null
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-2 text-sm shadow-sm",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold tabular-nums text-primary-foreground">
          {count}
        </span>
        已选 {count} {noun}
      </span>
      <div className="mx-1 h-4 w-px bg-border" />
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
      <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-muted-foreground" onClick={onClear}>
        <X className="h-3.5 w-3.5" /> 清除
      </Button>
    </div>
  )
}
