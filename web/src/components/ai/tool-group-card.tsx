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
import { ToolCard, type ToolStatus } from "./tool-card"
import { toolIcon, isDangerName } from "./tool-icons"
import type { ToolLike } from "@/lib/ai/group-tools"

const STATE_TONES = {
  running: "border-sky-500/40 bg-sky-50/40 dark:bg-sky-950/20",
  ok: "border-emerald-500/40 bg-emerald-50/40 dark:bg-emerald-950/20",
  mixed: "border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20",
  error: "border-destructive/50 bg-destructive/5",
  dry: "border-border bg-muted/40",
}

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
  let tone: keyof typeof STATE_TONES = "ok"
  if (failed > 0 && done + dry === items.length - failed) tone = "error"
  else if (failed > 0) tone = "mixed"
  else if (running > 0) tone = "running"
  else if (dry === items.length) tone = "dry"
  else tone = "ok"
  return { done, running, failed, dry, tone }
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
  const { done, running, failed, dry, tone } = summarize(items)
  const danger = isDangerName(name)

  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <motion.div
        layout={reduce ? false : "position"}
        transition={
          reduce
            ? { duration: 0 }
            : { type: "spring", stiffness: 320, damping: 30 }
        }
        className={cn(
          "flex-1 max-w-3xl rounded-xl border text-sm overflow-hidden shadow-sm",
          STATE_TONES[tone],
        )}
      >
        <Collapsible defaultOpen={defaultExpanded}>
          <Tooltip>
            <TooltipTrigger asChild>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-foreground/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <span
                    className={cn(
                      "inline-block w-2 h-2 rounded-full",
                      tone === "running"
                        ? "bg-sky-500"
                        : tone === "error"
                        ? "bg-destructive"
                        : tone === "mixed"
                        ? "bg-amber-500"
                        : tone === "dry"
                        ? "bg-muted-foreground"
                        : "bg-emerald-500",
                    )}
                  />
                  <Icon className="w-4 h-4 text-foreground/80" />
                  <code className="font-mono text-xs font-medium">{name}</code>
                  <Badge
                    variant="outline"
                    className="text-[10px] h-4 px-1.5 bg-background/60"
                  >
                    × {items.length}
                  </Badge>
                  {danger && (
                    <Badge
                      variant="destructive"
                      className="text-[10px] h-4 px-1.5"
                    >
                      高危
                    </Badge>
                  )}
                  <div className="ml-auto flex items-center gap-1.5 text-[10px]">
                    {done > 0 && (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 bg-background/60"
                      >
                        ✓ {done}
                      </Badge>
                    )}
                    {running > 0 && (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 border-sky-500/40 text-sky-700 dark:text-sky-300 bg-background/60"
                      >
                        <Loader2 className="w-2.5 h-2.5 mr-0.5 animate-spin" />
                        {running}
                      </Badge>
                    )}
                    {failed > 0 && (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 border-destructive/50 text-destructive bg-background/60"
                      >
                        ✗ {failed}
                      </Badge>
                    )}
                    {dry > 0 && (
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 border-border text-muted-foreground bg-background/60"
                      >
                        dry {dry}
                      </Badge>
                    )}
                  </div>
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
                </button>
              </CollapsibleTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">展开 / 折叠这组工具调用</TooltipContent>
          </Tooltip>
          <CollapsibleContent>
            <div className="px-2 pb-2 pt-1 space-y-2 bg-background/30">
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
