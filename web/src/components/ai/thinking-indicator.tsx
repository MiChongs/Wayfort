"use client"

import { motion, useReducedMotion } from "motion/react"
import { Bot } from "lucide-react"

export function ThinkingIndicator({ label = "正在思考" }: { label?: string }) {
  const reduce = useReducedMotion()
  return (
    <div className="flex gap-3 items-start">
      <motion.div
        className="w-7 h-7 rounded-full bg-card border flex items-center justify-center shrink-0"
        animate={reduce ? undefined : { scale: [1, 1.05, 1] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      >
        <Bot className="w-4 h-4" />
      </motion.div>
      <div className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="inline-block w-1.5 h-1.5 rounded-full bg-current"
            animate={reduce ? undefined : { scale: [1, 1.6, 1], opacity: [0.4, 1, 0.4] }}
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
