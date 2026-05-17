"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Copy, Info, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
}: {
  text?: string
  chunks?: string[]
  streaming?: boolean
  agent?: AIAgent
  message?: AIMessage
  onRegenerateFrom?: (msg: AIMessage) => void
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
    <div className="flex gap-3 group min-w-0">
      <AgentAvatar agent={agent} />
      <motion.div
        layout={reduce ? false : "position"}
        transition={
          reduce
            ? { duration: 0 }
            : { type: "spring", stiffness: 380, damping: 36 }
        }
        className="flex-1 min-w-0 max-w-3xl"
      >
        <Card className="relative bg-card border-border/60 overflow-hidden p-0 gap-0">
          <CardContent className="px-4 py-3 min-w-0">
            {copyValue.length > 0 && (
              <div
                className={cn(
                  "absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5",
                  "rounded-md border bg-background/90 backdrop-blur shadow-sm p-0.5",
                  "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity",
                )}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={doCopy}
                      aria-label="复制"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">复制全文</TooltipContent>
                </Tooltip>
                {message && onRegenerateFrom && !streaming && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => onRegenerateFrom(message)}
                        aria-label="从此处重发"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">从此处重发</TooltipContent>
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
                            className="h-6 w-6"
                            aria-label="元信息"
                          >
                            <Info className="w-3.5 h-3.5" />
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="top">元信息</TooltipContent>
                    </Tooltip>
                    <PopoverContent align="end" side="bottom" className="w-auto p-3">
                      <MessageMeta message={message} />
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            )}
            <div className="min-w-0">
              {hasChunks ? (
                <StreamingText chunks={chunks!} done={!streaming} />
              ) : (
                <Markdown text={value} />
              )}
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  )
}
