"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Check, Loader2, Minus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { statusMeta, type AgentTask } from "@/lib/ai/plan"

// One step in the plan, drawn as a timeline node: a connector line runs through
// the status dots so the panel reads as a sequence of steps. The active step is
// emphasized with a soft surface; status colors follow DESIGN.md (warm dots
// only — success / amber / brick, never coral).
export function TaskRow({
  task,
  index,
  isFirst,
  isLast,
}: {
  task: AgentTask
  index: number
  isFirst: boolean
  isLast: boolean
}) {
  const reduce = useReducedMotion()
  const meta = statusMeta(task.status)
  const active = task.status === "active"
  const done = task.status === "done" || task.status === "skipped"
  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex gap-2.5 px-2.5"
    >
      {/* timeline gutter: top stub (7px) → dot → flexible tail to next node */}
      <div className="flex w-4 shrink-0 flex-col items-center">
        <span
          aria-hidden
          className={cn("h-[7px] w-px", isFirst ? "bg-transparent" : done ? "bg-success/40" : "bg-border")}
        />
        <Dot status={task.status} reduce={!!reduce} />
        <span
          aria-hidden
          className={cn("w-px flex-1", isLast ? "bg-transparent" : done ? "bg-success/40" : "bg-border")}
        />
      </div>

      {/* content */}
      <div
        className={cn(
          "mb-1 min-w-0 flex-1 rounded-lg px-2 py-1.5 transition-colors",
          active && "bg-muted/60 ring-1 ring-border/50",
        )}
      >
        <div className="flex items-start gap-1.5">
          <span className="mt-px shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/55">
            {index + 1}
          </span>
          <span
            className={cn(
              "text-[13px] font-medium leading-snug",
              active ? "text-foreground" : "text-foreground/85",
              meta.strike && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </span>
        </div>
        {task.detail ? (
          <p className="mt-0.5 pl-[18px] text-[11px] leading-relaxed text-muted-foreground line-clamp-2">
            {task.detail}
          </p>
        ) : null}
      </div>
    </motion.li>
  )
}

function Dot({ status, reduce }: { status: AgentTask["status"]; reduce: boolean }) {
  const base =
    "relative z-10 my-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full"
  switch (status) {
    case "done":
      return (
        <span className={cn(base, "bg-success text-white")}>
          <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
        </span>
      )
    case "failed":
      return (
        <span className={cn(base, "bg-destructive text-white")}>
          <X className="h-2.5 w-2.5" strokeWidth={3.5} />
        </span>
      )
    case "skipped":
      return (
        <span className={cn(base, "bg-muted text-muted-foreground ring-1 ring-border")}>
          <Minus className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      )
    case "active":
      return (
        <span className={cn(base, "bg-warning/15 text-warning ring-2 ring-warning/30")}>
          <Loader2 className={cn("h-2.5 w-2.5", !reduce && "animate-spin")} strokeWidth={3} />
        </span>
      )
    default:
      return <span className={cn(base, "border-[1.5px] border-muted-foreground/35 bg-background")} />
  }
}
