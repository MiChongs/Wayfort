"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Brain, ChevronDown } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { StreamingText } from "./streaming-text"
import { AgentAvatar } from "./agent-avatar"
import type { AIAgent } from "@/lib/api/types"

// Extended-thinking trace, modelled on Claude.ai's web "Thinking" UI. While the
// model is still reasoning the header carries the signature shimmer sweep and
// the block is auto-open with a soft typewriter; once the main reply begins
// (parent flips `state` to "thought") it collapses into a quiet "已思考 Xs"
// pill the user can reopen. When the block LEADS a turn it carries the agent
// avatar in the gutter (gently breathing while it thinks) — exactly like
// Claude.ai, where the turn identity sits once at the top and the thinking is
// indented beneath it.
type Props = (
  | { state: "thinking"; chunks: string[] }
  | { state: "thought"; chunks: string[]; durationSec: number }
) & { lead?: boolean; agent?: AIAgent }

export const ReasoningBlock = React.memo(function ReasoningBlock(props: Props) {
  const reduce = useReducedMotion()
  const isStreaming = props.state === "thinking"
  const lead = props.lead ?? true
  const [open, setOpen] = React.useState(isStreaming)
  React.useEffect(() => {
    setOpen(isStreaming)
  }, [isStreaming])

  return (
    <div className="flex min-w-0 gap-3">
      <div className="flex w-7 shrink-0 justify-center">
        {lead ? (
          <div
            className={cn(
              isStreaming &&
                "motion-safe:[animation:ai-breathe_2.4s_ease-in-out_infinite]",
            )}
          >
            <AgentAvatar agent={props.agent} />
          </div>
        ) : (
          <span
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full border",
              isStreaming
                ? "border-primary/40 bg-primary/10 text-primary motion-safe:[animation:ai-breathe_2.4s_ease-in-out_infinite]"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            <Brain className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
      <motion.div
        layout={reduce ? false : "position"}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 36 }}
        className="min-w-0 max-w-3xl flex-1"
      >
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group flex w-full items-center gap-2 rounded-md py-1 text-left text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {lead && (
                <Brain
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    isStreaming ? "text-primary" : "text-muted-foreground",
                  )}
                />
              )}
              {isStreaming ? (
                <span className="ai-shimmer-brand font-medium tracking-tight">正在思考</span>
              ) : (
                <span className="font-medium text-muted-foreground">已思考 {props.durationSec}s</span>
              )}
              <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1 border-l-2 border-primary/25 pl-3">
              <ScrollArea className="max-h-[20rem]">
                <div className="pr-2 text-[13px] leading-relaxed text-muted-foreground/90">
                  <StreamingText chunks={props.chunks} done={!isStreaming} />
                </div>
              </ScrollArea>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </motion.div>
    </div>
  )
})
