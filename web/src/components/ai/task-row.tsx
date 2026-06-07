"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Check, Minus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { statusMeta, type AgentTask } from "@/lib/ai/plan"

// One line in the task panel: ordinal, a warm status dot, the title, and an
// optional detail line. Status colors follow DESIGN.md — warm semantic dots
// only (success / amber / brick), never coral on status.
export function TaskRow({ task, index }: { task: AgentTask; index: number }) {
  const meta = statusMeta(task.status)
  const reduce = useReducedMotion()
  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className="flex gap-2.5 px-3 py-2"
    >
      <span className="mt-0.5 w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70">
        {index + 1}
      </span>
      <span className="relative mt-[5px] flex h-2 w-2 shrink-0 items-center justify-center">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            meta.dotClass,
            meta.pulse && !reduce && "motion-safe:animate-pulse",
          )}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5">
          <span
            className={cn(
              "text-[13px] font-medium leading-snug text-foreground/90",
              meta.strike && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </span>
          <StatusIcon status={task.status} />
        </div>
        {task.detail ? (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{task.detail}</p>
        ) : null}
      </div>
    </motion.li>
  )
}

function StatusIcon({ status }: { status: AgentTask["status"] }) {
  if (status === "done")
    return <Check className="mt-[3px] h-3 w-3 shrink-0 text-success" aria-hidden />
  if (status === "failed")
    return <X className="mt-[3px] h-3 w-3 shrink-0 text-destructive" aria-hidden />
  if (status === "skipped")
    return <Minus className="mt-[3px] h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />
  return null
}
