"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ChevronDown, ListChecks } from "lucide-react"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { planProgress, type AgentTask } from "@/lib/ai/plan"
import { TaskRow } from "./task-row"

interface TaskPanelProps {
  tasks: AgentTask[]
  running?: boolean
  variant: "rail" | "inline"
  collapsed?: boolean
  onToggleCollapsed?: () => void
  className?: string
}

// The long-horizon agent's live TODO panel. Desktop renders it as a right rail
// (a layout sibling of the chat column, OUTSIDE the message scroll area so it
// never fights the sticky-bottom); mobile renders a collapsible block above the
// list. Surface + dots follow DESIGN.md: cream/muted card, hairline border, no
// shadow, the single scarce coral on the progress bar only.
export function TaskPanel({
  tasks,
  running,
  variant,
  collapsed,
  onToggleCollapsed,
  className,
}: TaskPanelProps) {
  const reduce = useReducedMotion()
  const prog = planProgress(tasks)
  const activeRunning = !!running && prog.active > 0

  const header = (
    <Header
      variant={variant}
      done={prog.done}
      total={prog.total}
      activeRunning={activeRunning}
      collapsed={collapsed}
      onToggle={onToggleCollapsed}
      reduce={!!reduce}
    />
  )

  const progressBar = (
    <div className="h-[2px] w-full overflow-hidden rounded-full bg-border/70">
      <motion.div
        className="h-full rounded-full bg-primary/70"
        initial={false}
        animate={{ width: `${prog.pct}%` }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 220, damping: 30 }}
      />
    </div>
  )

  const list = (
    <ul className="py-1">
      <AnimatePresence initial={false}>
        {tasks.map((t, i) => (
          <TaskRow key={t.id || `${t.ordinal}-${t.title}`} task={t} index={i} />
        ))}
      </AnimatePresence>
    </ul>
  )

  if (variant === "rail") {
    return (
      <aside
        className={cn(
          "flex h-full w-full flex-col overflow-hidden border-l border-border/70 bg-muted/20",
          className,
        )}
      >
        <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
          {header}
          {progressBar}
        </div>
        <ScrollArea className="min-h-0 flex-1">{list}</ScrollArea>
      </aside>
    )
  }

  // inline (mobile): collapsible block.
  return (
    <div className={cn("border-b border-border/70 bg-muted/25", className)}>
      <div className="space-y-2 px-3 py-2.5">
        {header}
        {progressBar}
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="max-h-[40vh] overflow-y-auto pb-1">{list}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Header({
  variant,
  done,
  total,
  activeRunning,
  collapsed,
  onToggle,
  reduce,
}: {
  variant: "rail" | "inline"
  done: number
  total: number
  activeRunning: boolean
  collapsed?: boolean
  onToggle?: () => void
  reduce: boolean
}) {
  const inner = (
    <>
      <span className="flex items-center gap-1.5">
        <ListChecks className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="eyebrow">执行计划</span>
        {activeRunning && (
          <motion.span
            className="ml-0.5 h-1.5 w-1.5 rounded-full bg-warning"
            animate={reduce ? undefined : { opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.4, repeat: Infinity }}
            aria-hidden
          />
        )}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
        {variant === "inline" && (
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              !collapsed && "rotate-180",
            )}
            aria-hidden
          />
        )}
      </span>
    </>
  )

  if (variant === "inline") {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:rounded"
        aria-expanded={!collapsed}
      >
        {inner}
      </button>
    )
  }
  return <div className="flex items-center justify-between">{inner}</div>
}
