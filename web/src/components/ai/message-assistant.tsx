"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Brain, ChevronDown, Copy, Info, RefreshCw } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"
import { StreamingText } from "./streaming-text"
import { AgentAvatar } from "./agent-avatar"
import { MessageMeta } from "./message-meta"
import type { AIAgent, AIMessage } from "@/lib/api/types"

export function AssistantBubble({
  text,
  chunks,
  streaming = false,
  agent,
  message,
  onRegenerateFrom,
  lead = true,
}: {
  text?: string
  chunks?: string[]
  streaming?: boolean
  agent?: AIAgent
  message?: AIMessage
  onRegenerateFrom?: (msg: AIMessage) => void
  // `lead` marks the first block of an assistant turn. Only the lead block
  // shows the agent avatar; continuation blocks (after a tool call, or a
  // second paragraph split by a tool result) align under the same gutter so
  // the whole turn reads as one stream — exactly like Claude.ai.
  lead?: boolean
}) {
  const reduce = useReducedMotion()
  const hasChunks = Array.isArray(chunks) && chunks.length > 0
  const value = text ?? ""
  const copyValue = hasChunks ? chunks!.join("") : value

  async function doCopy() {
    if (!copyValue) return
    try {
      await navigator.clipboard.writeText(copyValue)
      toast.success("已复制")
    } catch {
      toast.error("复制失败")
    }
  }

  return (
    <div className="group flex min-w-0 gap-3">
      {lead ? <AgentAvatar agent={agent} /> : <div className="h-7 w-7 shrink-0" />}
      <motion.div
        layout={reduce ? false : "position"}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 36 }}
        className="min-w-0 flex-1 pt-0.5"
      >
        {message?.reasoning && <PersistedReasoning text={message.reasoning} />}
        {/* Borderless, Claude-web style: the reply is just rendered prose in the
            content column — no card, no background. */}
        <div className="min-w-0 text-[15px] leading-relaxed">
          {hasChunks ? (
            <StreamingText chunks={chunks!} done={!streaming} />
          ) : (
            <Markdown text={value} />
          )}
        </div>

        {/* Action row — appears under the settled reply on hover. */}
        {copyValue.length > 0 && !streaming && (
          <div className="-ml-1.5 mt-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={doCopy}
                  aria-label="复制"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">复制全文</TooltipContent>
            </Tooltip>
            {message && onRegenerateFrom && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => onRegenerateFrom(message)}
                    aria-label="从此处重发"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">从此处重发</TooltipContent>
              </Tooltip>
            )}
            {message && (
              <Popover>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        aria-label="元信息"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">元信息</TooltipContent>
                </Tooltip>
                <PopoverContent align="start" side="bottom" className="w-auto p-3">
                  <MessageMeta message={message} />
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}
      </motion.div>
    </div>
  )
}

// PersistedReasoning renders an assistant turn's saved extended-thinking trace
// as a quiet, collapsed "已思考" disclosure above the reply — so reasoning that
// streamed live during the turn survives a page reload.
function PersistedReasoning({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-2">
      <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-foreground/5 focus:outline-none"
          >
            <Brain className="h-3.5 w-3.5 shrink-0 text-violet-500" />
            <span className="font-medium text-muted-foreground">已思考</span>
            <ChevronDown className="ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-3 py-2 text-[13px] italic leading-relaxed text-muted-foreground">
            <Markdown text={text} />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
