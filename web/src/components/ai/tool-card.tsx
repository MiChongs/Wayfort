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
import { ToolOutputView } from "./tool-output"
import { toolIcon } from "./tool-icons"

export type ToolStatus = "pending" | "running" | "output" | "error" | "dry_run"

const STATUS_STYLES: Record<
  ToolStatus,
  { wrap: string; badge: string; dot: string; label: string }
> = {
  pending: {
    wrap: "border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20",
    badge: "border-amber-500/40 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
    label: "等待中",
  },
  running: {
    wrap: "border-sky-500/40 bg-sky-50/40 dark:bg-sky-950/20",
    badge: "border-sky-500/40 text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
    label: "运行中",
  },
  output: {
    wrap: "border-emerald-500/40 bg-emerald-50/40 dark:bg-emerald-950/20",
    badge: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
    label: "已完成",
  },
  dry_run: {
    wrap: "border-border bg-muted/40",
    badge: "border-border text-muted-foreground",
    dot: "bg-muted-foreground",
    label: "Plan dry-run",
  },
  error: {
    wrap: "border-destructive/50 bg-destructive/5",
    badge: "border-destructive/50 text-destructive",
    dot: "bg-destructive",
    label: "失败",
  },
}

export const ToolCard = React.memo(function ToolCard({
  name,
  status,
  output,
  error,
  danger,
  defaultExpanded = true,
}: {
  name: string
  status: ToolStatus
  output?: string
  error?: string
  danger?: boolean
  defaultExpanded?: boolean
}) {
  const reduce = useReducedMotion()
  const Icon = toolIcon(name)
  const styles = STATUS_STYLES[status]
  const hasBody = !!(output || error)

  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <motion.div
        layout="position"
        transition={
          reduce
            ? { duration: 0 }
            : { type: "spring", stiffness: 320, damping: 30 }
        }
        className={cn(
          "flex-1 max-w-3xl rounded-xl border text-sm overflow-hidden shadow-sm",
          styles.wrap,
        )}
      >
        <Collapsible defaultOpen={defaultExpanded && hasBody}>
          <Tooltip>
            <TooltipTrigger asChild>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  disabled={!hasBody}
                  className={cn(
                    "group w-full flex items-center gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    hasBody
                      ? "hover:bg-foreground/5 cursor-pointer"
                      : "cursor-default",
                  )}
                  aria-label={
                    hasBody ? "切换工具输出折叠" : undefined
                  }
                >
                  <span
                    className={cn(
                      "inline-block w-2 h-2 rounded-full",
                      styles.dot,
                    )}
                  />
                  <Icon className="w-4 h-4 text-foreground/80" />
                  <code className="font-mono text-xs font-medium">{name}</code>
                  {danger && (
                    <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
                      高危
                    </Badge>
                  )}
                  <Badge
                    variant="outline"
                    className={cn(
                      "ml-auto text-[10px] h-5 bg-background/60",
                      styles.badge,
                    )}
                  >
                    {styles.label}
                  </Badge>
                  {status === "running" && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500" />
                  )}
                  {hasBody && (
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
                  )}
                </button>
              </CollapsibleTrigger>
            </TooltipTrigger>
            {hasBody && <TooltipContent side="top">点击折叠/展开</TooltipContent>}
          </Tooltip>
          {hasBody && (
            <CollapsibleContent>
              <div className="px-3 pb-3 pt-1">
                {output && <ToolOutputView raw={output} danger={danger} />}
                {error && (
                  <div className="mt-1 text-xs text-destructive bg-destructive/10 rounded px-2 py-1.5 font-mono whitespace-pre-wrap">
                    {error}
                  </div>
                )}
              </div>
            </CollapsibleContent>
          )}
        </Collapsible>
      </motion.div>
    </div>
  )
})
