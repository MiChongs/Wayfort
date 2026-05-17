"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { Markdown } from "./markdown"

// Smooth, segmented fade-in for streaming assistant text.
//
// During streaming we render each SSE chunk as a `motion.span` that fades in
// (~12ms) with a tiny y/blur transition — visually it looks like text is being
// written. We avoid rendering Markdown until the stream completes so code
// fences / lists don't visually re-flow on every delta. A blinking caret at
// the tail signals "still typing".
export function StreamingText({
  chunks,
  done,
}: {
  chunks: string[]
  done: boolean
}) {
  const reduce = useReducedMotion()

  if (done) {
    const full = chunks.join("")
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reduce ? 0 : 0.15 }}
      >
        <Markdown text={full} />
      </motion.div>
    )
  }

  // Split long chunks into ~10-char sub-chunks so a single delta doesn't pop
  // in as a wall of text.
  const segments = React.useMemo(() => splitChunks(chunks), [chunks])

  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed font-sans">
      <AnimatePresence initial={false}>
        {segments.map((seg, i) => (
          <motion.span
            key={i}
            initial={reduce ? false : { opacity: 0, y: 2, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: reduce ? 0 : 0.12, ease: "easeOut" }}
          >
            {seg}
          </motion.span>
        ))}
      </AnimatePresence>
      <Caret />
    </div>
  )
}

function splitChunks(chunks: string[]): string[] {
  const out: string[] = []
  for (const c of chunks) {
    if (!c) continue
    if (c.length <= 12) {
      out.push(c)
      continue
    }
    // Break on whitespace boundaries when possible to avoid splitting mid-word.
    let cursor = 0
    while (cursor < c.length) {
      let end = Math.min(cursor + 12, c.length)
      if (end < c.length) {
        const ws = c.lastIndexOf(" ", end)
        if (ws > cursor + 4) end = ws + 1
      }
      out.push(c.slice(cursor, end))
      cursor = end
    }
  }
  return out
}

function Caret() {
  const reduce = useReducedMotion()
  return (
    <motion.span
      aria-hidden
      className="inline-block w-[2px] h-[1.05em] -mb-[3px] ml-[1px] bg-foreground/80 align-baseline"
      animate={reduce ? undefined : { opacity: [1, 0, 1] }}
      transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
    />
  )
}
