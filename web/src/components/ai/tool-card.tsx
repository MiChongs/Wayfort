"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ChevronDown, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { ToolOutputView } from "./tool-output"
import { toolIcon } from "./tool-icons"

export type ToolStatus = "pending" | "running" | "output" | "error" | "dry_run"

const STATUS_STYLES: Record<ToolStatus, { wrap: string; badge: string; dot: string; label: string }> = {
  pending: {
    wrap: "border-amber-500/40 bg-amber-500/5",
    badge: "border-amber-500/40 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    label: "等待中",
  },
  running: {
    wrap: "border-sky-500/40 bg-sky-500/5",
    badge: "border-sky-500/40 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
    label: "运行中",
  },
  output: {
    wrap: "border-emerald-500/40 bg-emerald-500/5",
    badge: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
    label: "已完成",
  },
  dry_run: {
    wrap: "border-zinc-400/40 bg-zinc-500/5",
    badge: "border-zinc-400/40 text-zinc-600 dark:text-zinc-300",
    dot: "bg-zinc-400",
    label: "Plan dry-run",
  },
  error: {
    wrap: "border-destructive/50 bg-destructive/5",
    badge: "border-destructive/50 text-destructive",
    dot: "bg-destructive",
    label: "失败",
  },
}

export function ToolCard({
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
  const [expanded, setExpanded] = React.useState(defaultExpanded)

  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <motion.div
        layout="position"
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 30 }}
        className={cn(
          "flex-1 max-w-3xl rounded-xl border text-sm overflow-hidden",
          styles.wrap,
        )}
      >
        <button
          type="button"
          onClick={() => hasBody && setExpanded((v) => !v)}
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2 text-left",
            hasBody ? "hover:bg-foreground/5 cursor-pointer" : "cursor-default",
          )}
        >
          <span className={cn("inline-block w-2 h-2 rounded-full", styles.dot)} />
          <Icon className="w-4 h-4 text-foreground/80" />
          <code className="font-mono text-xs font-medium">{name}</code>
          {danger && (
            <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
              高危
            </Badge>
          )}
          <Badge variant="outline" className={cn("ml-auto text-[10px] h-5", styles.badge)}>
            {styles.label}
          </Badge>
          {status === "running" && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500" />}
          {hasBody && (
            <motion.span
              animate={{ rotate: expanded ? 0 : -90 }}
              transition={reduce ? { duration: 0 } : { duration: 0.18 }}
              className="text-muted-foreground"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </motion.span>
          )}
        </button>
        <AnimatePresence initial={false}>
          {expanded && hasBody && (
            <motion.div
              key="body"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3">
                {output && <ToolOutputView raw={output} danger={danger} />}
                {error && (
                  <div className="mt-1 text-xs text-destructive bg-destructive/10 rounded px-2 py-1.5 font-mono whitespace-pre-wrap">
                    {error}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
