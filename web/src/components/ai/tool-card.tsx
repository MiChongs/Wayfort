"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Check, ChevronDown, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { ToolOutputView } from "./tool-output"
import { toolIcon } from "./tool-icons"

export type ToolStatus = "pending" | "running" | "output" | "error" | "dry_run"

// Claude.ai keeps tool use visually quiet: a single monochrome row that
// expands to reveal output. We follow that — colour is reserved for the two
// signals that matter in a bastion context: danger (high-risk tool) and
// failure. Everything else is muted.
const STATUS_LABEL: Record<ToolStatus, string> = {
  pending: "排队中",
  running: "运行中",
  output: "已完成",
  dry_run: "预演",
  error: "失败",
}

function StatusGlyph({ status }: { status: ToolStatus }) {
  if (status === "running")
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
  if (status === "output")
    return <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  return (
    <span
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        status === "error"
          ? "bg-destructive"
          : status === "pending"
          ? "bg-muted-foreground/70 motion-safe:animate-pulse"
          : "bg-muted-foreground/50",
      )}
    />
  )
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
  const hasBody = !!(output || error)

  return (
    // The w-7 spacer lines tool rows up under the assistant's prose column
    // (whose avatar occupies the same gutter), so a turn reads as one stream.
    <div className="flex gap-3">
      <div className="h-7 w-7 shrink-0" />
      <motion.div
        layout="position"
        transition={
          reduce ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 30 }
        }
        className={cn(
          "max-w-3xl flex-1 overflow-hidden rounded-lg border text-sm transition-colors",
          status === "error"
            ? "border-destructive/40 bg-destructive/[0.035]"
            : danger
            ? "border-destructive/25 bg-muted/20"
            : "border-border/70 bg-muted/25",
        )}
      >
        <Collapsible defaultOpen={defaultExpanded && hasBody}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              disabled={!hasBody}
              className={cn(
                "group flex w-full items-center gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                hasBody ? "cursor-pointer hover:bg-foreground/[0.035]" : "cursor-default",
              )}
              aria-label={hasBody ? "切换工具输出折叠" : undefined}
            >
              <StatusGlyph status={status} />
              <Icon className="h-4 w-4 shrink-0 text-foreground/70" />
              <code className="truncate font-mono text-xs font-medium text-foreground/90">
                {name}
              </code>
              {danger && (
                <Badge
                  variant="outline"
                  className="h-4 shrink-0 border-destructive/40 px-1.5 text-[10px] text-destructive"
                >
                  高危
                </Badge>
              )}
              {name === "knowledge_search" && (
                <Badge
                  variant="outline"
                  className="h-4 shrink-0 px-1.5 text-[10px] text-muted-foreground"
                >
                  RAG
                </Badge>
              )}
              <span
                className={cn(
                  "ml-auto shrink-0 text-[11px] tabular-nums",
                  status === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {STATUS_LABEL[status]}
              </span>
              {hasBody && (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
              )}
            </button>
          </CollapsibleTrigger>
          {hasBody && (
            <CollapsibleContent>
              <div className="border-t border-border/50 px-3 pb-3 pt-2">
                {output && <ToolOutputView raw={output} danger={danger} toolName={name} />}
                {error && (
                  <div className="mt-1 whitespace-pre-wrap rounded bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive">
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
