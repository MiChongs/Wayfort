"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { ChevronDown, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { ToolCard } from "./tool-card"
import { toolIcon, isDangerName } from "./tool-icons"
import type { ToolLike } from "@/lib/ai/group-tools"

function summarize(items: ToolLike[]) {
  let done = 0
  let running = 0
  let failed = 0
  let dry = 0
  for (const t of items) {
    if (t.status === "running" || t.status === "pending") running++
    else if (t.status === "error") failed++
    else if (t.status === "dry_run") dry++
    else done++
  }
  return { done, running, failed, dry }
}

export const ToolGroupCard = React.memo(function ToolGroupCard({
  name,
  items,
  defaultExpanded = false,
}: {
  name: string
  items: ToolLike[]
  defaultExpanded?: boolean
}) {
  const reduce = useReducedMotion()
  const Icon = toolIcon(name)
  const { done, running, failed, dry } = summarize(items)
  const danger = isDangerName(name)

  return (
    <div className="flex gap-3">
      <div className="h-7 w-7 shrink-0" />
      <motion.div
        layout={reduce ? false : "position"}
        transition={
          reduce
            ? { duration: 0 }
            : { type: "spring", stiffness: 320, damping: 30 }
        }
        className={cn(
          "max-w-3xl flex-1 overflow-hidden rounded-lg border text-sm transition-colors",
          failed > 0
            ? "border-destructive/40 bg-destructive/[0.035]"
            : danger
            ? "border-destructive/25 bg-muted/20"
            : "border-border/70 bg-muted/25",
        )}
      >
        <Collapsible defaultOpen={defaultExpanded}>
          <Tooltip>
            <TooltipTrigger asChild>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-foreground/[0.035] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {running > 0 ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        failed > 0 ? "bg-destructive" : "bg-muted-foreground/50",
                      )}
                    />
                  )}
                  <Icon className="h-4 w-4 shrink-0 text-foreground/70" />
                  <code className="truncate font-mono text-xs font-medium text-foreground/90">
                    {name}
                  </code>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    ×{items.length}
                  </span>
                  {danger && (
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 border-destructive/40 px-1.5 text-[10px] text-destructive"
                    >
                      高危
                    </Badge>
                  )}
                  <div className="ml-auto flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
                    {done > 0 && <span>✓ {done}</span>}
                    {running > 0 && <span>{running} 运行中</span>}
                    {dry > 0 && <span>预演 {dry}</span>}
                    {failed > 0 && (
                      <span className="text-destructive">✗ {failed}</span>
                    )}
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
                </button>
              </CollapsibleTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">展开 / 折叠这组工具调用</TooltipContent>
          </Tooltip>
          <CollapsibleContent>
            <div className="space-y-2 px-2 pb-2 pt-1">
              {items.map((it) => (
                // re-use ToolCard styling; pass danger from group's name
                <ToolCard
                  key={it.id}
                  name={it.name}
                  status={it.status}
                  output={it.output}
                  error={it.error}
                  danger={it.danger ?? danger}
                  defaultExpanded={false}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </motion.div>
    </div>
  )
})
