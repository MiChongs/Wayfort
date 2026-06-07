"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Check, ChevronDown, ListChecks } from "lucide-react"
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

// The long-horizon agent's live plan, drawn as a vertical timeline of steps.
// Desktop = right rail (a layout sibling OUTSIDE the message scroll area, so it
// never fights the sticky-bottom); mobile = collapsible block above the list.
// Surface + dots follow DESIGN.md (cream/muted card, hairline borders, no big
// shadow; the single scarce coral lives on the icon tile + progress fill).
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
  const allDone = prog.total > 0 && prog.done === prog.total
  const activeTitle = tasks.find((t) => t.status === "active")?.title

  const list = (
    <ol className="py-2">
      <AnimatePresence initial={false}>
        {tasks.map((t, i) => (
          <TaskRow
            key={t.id || `${t.ordinal}-${t.title}`}
            task={t}
            index={i}
            isFirst={i === 0}
            isLast={i === tasks.length - 1}
          />
        ))}
      </AnimatePresence>
    </ol>
  )

  const head = (
    <Header
      variant={variant}
      done={prog.done}
      total={prog.total}
      pct={prog.pct}
      allDone={allDone}
      running={!!running}
      activeTitle={activeTitle}
      collapsed={collapsed}
      onToggle={onToggleCollapsed}
      reduce={!!reduce}
    />
  )

  if (variant === "rail") {
    return (
      <aside
        className={cn(
          "flex h-full w-full flex-col overflow-hidden border-l border-border/70 bg-muted/15",
          className,
        )}
      >
        <div className="shrink-0 border-b border-border/60 px-3 pb-3 pt-3.5">{head}</div>
        <ScrollArea className="min-h-0 flex-1">{list}</ScrollArea>
      </aside>
    )
  }

  // inline (mobile): collapsible block.
  return (
    <div className={cn("border-b border-border/70 bg-muted/25", className)}>
      <div className="px-3 py-2.5">{head}</div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="max-h-[42vh] overflow-y-auto pb-1">{list}</div>
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
  pct,
  allDone,
  running,
  activeTitle,
  collapsed,
  onToggle,
  reduce,
}: {
  variant: "rail" | "inline"
  done: number
  total: number
  pct: number
  allDone: boolean
  running: boolean
  activeTitle?: string
  collapsed?: boolean
  onToggle?: () => void
  reduce: boolean
}) {
  const titleRow = (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <ListChecks className="h-3 w-3" aria-hidden />
        </span>
        <span className="eyebrow">执行计划</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {allDone ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
            <Check className="h-3 w-3" strokeWidth={3} /> 完成
          </span>
        ) : (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {done}/{total}
          </span>
        )}
        {variant === "inline" && (
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", !collapsed && "rotate-180")}
            aria-hidden
          />
        )}
      </span>
    </div>
  )

  return (
    <div className="space-y-2">
      {variant === "inline" ? (
        <button
          type="button"
          onClick={onToggle}
          className="block w-full text-left focus:outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-expanded={!collapsed}
        >
          {titleRow}
        </button>
      ) : (
        titleRow
      )}

      {/* progress bar + percentage */}
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/60">
          <motion.div
            className={cn("h-full rounded-full", allDone ? "bg-success" : "bg-primary/70")}
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 220, damping: 30 }}
          />
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
      </div>

      {/* active step glance line */}
      <AnimatePresence initial={false}>
        {running && activeTitle && !allDone && (
          <motion.div
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            className="flex items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning motion-safe:animate-pulse" aria-hidden />
            <span className="truncate">进行中 · {activeTitle}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
