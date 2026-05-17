"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { Users, ChevronDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export function SubAgentCard({
  agent,
  eventKind,
  text,
  payload,
}: {
  agent: string
  eventKind?: string
  text?: string
  payload?: string
}) {
  const reduce = useReducedMotion()
  const [expanded, setExpanded] = React.useState(false)
  const hasPayload = !!payload

  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <motion.div
        layout="position"
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 30 }}
        className="flex-1 max-w-3xl rounded-xl border border-violet-500/40 bg-violet-50/40 dark:bg-violet-950/20 overflow-hidden"
      >
        <button
          type="button"
          onClick={() => hasPayload && setExpanded((v) => !v)}
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2 text-left text-sm",
            hasPayload ? "hover:bg-foreground/5 cursor-pointer" : "cursor-default",
          )}
        >
          <Users className="w-4 h-4 text-violet-600 dark:text-violet-300" />
          <span className="font-medium text-violet-900 dark:text-violet-100 text-xs">
            子 Agent
          </span>
          <code className="font-mono text-xs">{agent}</code>
          {eventKind && (
            <Badge variant="outline" className="text-[10px] h-5 border-violet-500/40">
              {eventKind}
            </Badge>
          )}
          {hasPayload && (
            <motion.span
              animate={{ rotate: expanded ? 0 : -90 }}
              transition={reduce ? { duration: 0 } : { duration: 0.18 }}
              className="ml-auto text-muted-foreground"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </motion.span>
          )}
        </button>
        {text && (
          <div className="px-3 pb-2 -mt-1 text-sm text-violet-900/90 dark:text-violet-100/90 whitespace-pre-wrap break-words">
            {text}
          </div>
        )}
        <AnimatePresence initial={false}>
          {expanded && hasPayload && (
            <motion.div
              key="payload"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
              className="overflow-hidden"
            >
              <pre className="mx-3 mb-3 rounded bg-muted text-foreground p-2 text-[11px] leading-relaxed overflow-auto">
                {payload}
              </pre>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
