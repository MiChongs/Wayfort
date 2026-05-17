"use client"

import { motion, useReducedMotion } from "motion/react"
import { Users, ChevronDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"

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
  const hasPayload = !!payload

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
        className="flex-1 max-w-3xl rounded-xl border border-violet-500/40 bg-violet-50/40 dark:bg-violet-950/20 overflow-hidden"
      >
        <Collapsible>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              disabled={!hasPayload}
              className="group w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
            >
              <Users className="w-4 h-4 text-violet-600 dark:text-violet-300" />
              <span className="font-medium text-violet-900 dark:text-violet-100 text-xs">
                子 Agent
              </span>
              <code className="font-mono text-xs">{agent}</code>
              {eventKind && (
                <Badge
                  variant="outline"
                  className="text-[10px] h-5 border-violet-500/40 text-violet-700 dark:text-violet-300"
                >
                  {eventKind}
                </Badge>
              )}
              {hasPayload && (
                <ChevronDown className="ml-auto w-3.5 h-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
              )}
            </button>
          </CollapsibleTrigger>
          {text && (
            <div className="px-3 pb-2 -mt-1 text-sm text-violet-900/90 dark:text-violet-100/90 whitespace-pre-wrap break-words">
              {text}
            </div>
          )}
          {hasPayload && (
            <CollapsibleContent>
              <ScrollArea className="mx-3 mb-3 rounded bg-muted text-foreground max-h-[18rem]">
                <pre className="p-2 text-[11px] leading-relaxed font-mono">
                  {payload}
                </pre>
              </ScrollArea>
            </CollapsibleContent>
          )}
        </Collapsible>
      </motion.div>
    </div>
  )
}
