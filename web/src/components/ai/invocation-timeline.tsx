"use client"

import { motion, useReducedMotion } from "motion/react"
import { Virtuoso } from "react-virtuoso"
import { Clock, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ToolOutputView } from "./tool-output"
import { toolIcon, isDangerName } from "./tool-icons"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AIToolInvocation } from "@/lib/api/types"

// Semantic status tokens (DESIGN: warm sage / amber / brick — never cool
// emerald/sky/amber-500).
const STATUS_COLOR: Record<AIToolInvocation["status"], string> = {
  pending: "bg-warning",
  approved: "bg-primary",
  rejected: "bg-muted-foreground",
  running: "bg-primary motion-safe:animate-pulse",
  succeeded: "bg-success",
  failed: "bg-destructive",
  dry_run: "bg-muted-foreground",
}

// Above this many calls the timeline virtualises; below it we keep the staggered
// entrance animation.
const VIRTUALIZE_AT = 30

function TimelineRow({ inv }: { inv: AIToolInvocation }) {
  const Icon = toolIcon(inv.tool_name)
  return (
    // Per-row connector + dot: an absolute full-height hairline behind each row
    // keeps the timeline line continuous even inside a virtualised container
    // (a single absolute line can't span recycled rows).
    <div className="relative pb-4 pl-10">
      <span aria-hidden className="absolute left-[15px] top-0 h-full w-px bg-border" />
      <span
        className={cn(
          "absolute left-2 top-3 size-[14px] rounded-full border-2 border-background",
          STATUS_COLOR[inv.status],
        )}
      />
      <Card className="overflow-hidden">
        <CardContent className="py-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <Icon className="size-4 text-foreground/80" />
                <code className="font-mono">{inv.tool_name}</code>
                {isDangerName(inv.tool_name) && (
                  <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                    高危
                  </Badge>
                )}
                <Badge variant="outline" className="h-5 text-[10px]">
                  {inv.status}
                </Badge>
                <Badge variant="secondary" className="h-5 text-[10px]">
                  {inv.permission_mode}
                </Badge>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" /> {fullTime(inv.created_at)}
                </span>
                <span>· {relTime(inv.created_at)}</span>
                {typeof inv.duration_ms === "number" && inv.duration_ms > 0 && (
                  <span>· {inv.duration_ms} ms</span>
                )}
                {inv.output_truncated && <span>· 输出已截断</span>}
              </div>
            </div>
            <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {inv.id.slice(0, 8)}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            <Collapsible>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
                  输入参数
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1 overflow-auto rounded border border-border/60 bg-muted p-2 text-[11px] leading-relaxed text-foreground">
                  {prettyJson(inv.input)}
                </pre>
              </CollapsibleContent>
            </Collapsible>

            {inv.output && (
              <Collapsible defaultOpen>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="group inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
                    输出 ({fmtBytes(inv.output.length)})
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-1">
                    <ToolOutputView raw={inv.output} toolName={inv.tool_name} />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            {inv.error && (
              <div className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive">
                错误：{inv.error}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export function InvocationTimeline({
  invocations,
}: {
  invocations: AIToolInvocation[]
}) {
  const reduce = useReducedMotion()

  if (invocations.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        本会话还没有任何工具调用
      </div>
    )
  }

  const rows = invocations.slice().reverse()

  if (rows.length > VIRTUALIZE_AT) {
    return (
      <div
        className="mx-auto max-w-4xl px-4 py-6 md:px-6"
        style={{ height: "min(100%, calc(100dvh - 13rem))" }}
      >
        <Virtuoso
          data={rows}
          className="no-scrollbar h-full"
          itemContent={(_i, inv) => <TimelineRow inv={inv} />}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
      {rows.map((inv, i) => (
        <motion.div
          key={inv.id}
          initial={reduce ? false : { opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={
            reduce ? { duration: 0 } : { duration: 0.3, delay: Math.min(i * 0.04, 0.32), ease: "easeOut" }
          }
        >
          <TimelineRow inv={inv} />
        </motion.div>
      ))}
    </div>
  )
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}
