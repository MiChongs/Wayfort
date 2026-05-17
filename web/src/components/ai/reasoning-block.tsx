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

// Visual treatment for an extended-thinking / reasoning trace, modelled on
// Claude.ai's "Extended Thinking" UI. While the model is still emitting
// reasoning the block is auto-open with a pulsing brain icon and live
// typewriter. Once main text begins (parent flips `state` from "thinking"
// to "thought"), the block auto-collapses into a quiet "已思考 Xs" pill
// that the user can click to read the full reasoning.
type Props =
  | { state: "thinking"; chunks: string[] }
  | { state: "thought"; chunks: string[]; durationSec: number }

export const ReasoningBlock = React.memo(function ReasoningBlock(props: Props) {
  const reduce = useReducedMotion()
  const isStreaming = props.state === "thinking"
  // Defer open-state to local; default-open while streaming, auto-collapse
  // when transitioning to "thought".
  const [open, setOpen] = React.useState(isStreaming)
  React.useEffect(() => {
    if (isStreaming) setOpen(true)
    else setOpen(false)
  }, [isStreaming])

  return (
    <div className="flex gap-3 min-w-0">
      <div className="w-7 h-7 shrink-0 rounded-full bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-violet-600 dark:text-violet-300">
        <motion.span
          animate={
            reduce || !isStreaming
              ? undefined
              : { scale: [1, 1.15, 1], opacity: [0.8, 1, 0.8] }
          }
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          className="inline-flex"
        >
          <Brain className="w-3.5 h-3.5" />
        </motion.span>
      </div>
      <motion.div
        layout={reduce ? false : "position"}
        transition={
          reduce
            ? { duration: 0 }
            : { type: "spring", stiffness: 380, damping: 36 }
        }
        className="flex-1 min-w-0 max-w-3xl"
      >
        <Collapsible open={open} onOpenChange={setOpen}>
          <div
            className={cn(
              "rounded-xl border overflow-hidden transition-colors",
              isStreaming
                ? "border-violet-500/40 bg-violet-50/40 dark:bg-violet-950/20"
                : "border-border bg-muted/40",
            )}
          >
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className={cn(
                  "group w-full flex items-center gap-2 px-3 py-2 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  "hover:bg-foreground/5 cursor-pointer",
                )}
              >
                <span
                  className={cn(
                    "inline-block w-1.5 h-1.5 rounded-full",
                    isStreaming
                      ? "bg-violet-500 animate-pulse"
                      : "bg-muted-foreground",
                  )}
                />
                <span
                  className={cn(
                    "font-medium",
                    isStreaming
                      ? "text-violet-700 dark:text-violet-300"
                      : "text-muted-foreground",
                  )}
                >
                  {isStreaming
                    ? "正在思考"
                    : `已思考 ${props.durationSec}s`}
                </span>
                {isStreaming && <ThinkingDots />}
                <ChevronDown className="ml-auto w-3.5 h-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-3 pb-3 pt-1">
                <ScrollArea className="max-h-[20rem]">
                  <div className="pr-2">
                    <div className="italic text-muted-foreground text-[13px] leading-relaxed">
                      <StreamingText
                        chunks={props.chunks}
                        done={!isStreaming}
                      />
                    </div>
                  </div>
                </ScrollArea>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </motion.div>
    </div>
  )
})

function ThinkingDots() {
  const reduce = useReducedMotion()
  return (
    <span className="inline-flex items-center gap-1 ml-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block w-1 h-1 rounded-full bg-violet-500"
          animate={
            reduce
              ? undefined
              : { scale: [1, 1.6, 1], opacity: [0.4, 1, 0.4] }
          }
          transition={{
            duration: 0.9,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.12,
          }}
        />
      ))}
    </span>
  )
}
