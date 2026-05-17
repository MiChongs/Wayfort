"use client"

import { motion, useReducedMotion } from "motion/react"
import { AgentAvatar } from "./agent-avatar"
import type { AIAgent } from "@/lib/api/types"

export function ThinkingIndicator({
  label = "正在思考",
  agent,
}: {
  label?: string
  agent?: AIAgent
}) {
  const reduce = useReducedMotion()
  return (
    <div className="flex gap-3 items-start">
      <motion.div
        animate={reduce ? undefined : { scale: [1, 1.05, 1] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      >
        <AgentAvatar agent={agent} />
      </motion.div>
      <div className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="inline-block w-1.5 h-1.5 rounded-full bg-current"
            animate={
              reduce ? undefined : { scale: [1, 1.6, 1], opacity: [0.4, 1, 0.4] }
            }
            transition={{
              duration: 0.9,
              repeat: Infinity,
              ease: "easeInOut",
              delay: i * 0.12,
            }}
          />
        ))}
        <span className="ml-1">{label}…</span>
      </div>
    </div>
  )
}
