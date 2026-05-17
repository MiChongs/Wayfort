"use client"

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
  // When streaming: render the chunk-based smoothed view. When done (chunks
  // supplied but streaming=false), still use StreamingText with done=true so
  // the final Markdown render fades in cleanly. When no chunks: classic
  // persisted-history path, render Markdown directly.
  const hasChunks = Array.isArray(chunks) && chunks.length > 0
  const value = text ?? ""

  return (
    <div className="flex gap-3 group">
      <AgentAvatar agent={agent} />
      <Card className="flex-1 max-w-3xl border-border/60 bg-card/80 backdrop-blur-sm">
        <CardContent className="pt-4 pb-4 relative">
          {value.length > 0 && (
            <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-2 right-2">
              <CopyButton value={hasChunks ? chunks!.join("") : value} variant="ghost" />
            </div>
          )}
          {hasChunks ? (
            <StreamingText chunks={chunks!} done={!streaming} />
          ) : (
            <Markdown text={value} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
