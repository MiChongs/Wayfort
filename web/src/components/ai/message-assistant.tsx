"use client"

import { motion, useReducedMotion } from "motion/react"
import { Card, CardContent } from "@/components/ui/card"
import { CopyButton } from "@/components/common/copy-button"
import { Markdown } from "./markdown"
import { StreamingText } from "./streaming-text"
import { AgentAvatar } from "./agent-avatar"
import type { AIAgent } from "@/lib/api/types"

export function AssistantBubble({
  text,
  chunks,
  streaming = false,
  agent,
}: {
  text?: string
  chunks?: string[]
  streaming?: boolean
  agent?: AIAgent
}) {
  const reduce = useReducedMotion()
  const hasChunks = Array.isArray(chunks) && chunks.length > 0
  const value = text ?? ""
  const copyValue = hasChunks ? chunks!.join("") : value

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
              <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-1.5 right-1.5 z-10">
                <CopyButton value={copyValue} variant="ghost" />
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
