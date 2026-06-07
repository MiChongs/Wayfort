"use client"

import { AgentAvatar } from "./agent-avatar"
import type { AIAgent } from "@/lib/api/types"

// Pre-first-token state, modelled on Claude.ai: a calm shimmering label next to
// a softly breathing avatar — no busy bouncing dots. The shimmer sweep is the
// signature "thinking" motion; it reads as alive but unhurried.
export function ThinkingIndicator({
  label = "正在思考",
  agent,
}: {
  label?: string
  agent?: AIAgent
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="motion-safe:[animation:ai-breathe_2.6s_ease-in-out_infinite]">
        <AgentAvatar agent={agent} />
      </div>
      <div className="flex items-center pt-1.5">
        <span className="ai-shimmer-brand text-sm font-medium tracking-tight">{label}…</span>
      </div>
    </div>
  )
}
