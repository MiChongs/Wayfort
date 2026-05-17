"use client"

import * as React from "react"
import { animate, motion, useReducedMotion } from "motion/react"
import { Markdown } from "./markdown"

// Smooth typewriter driven by motion's `animate`. We track how many
// characters of the cumulative SSE text are currently displayed; whenever
// the upstream content grows, we tween the count from "wherever we are now"
// to the new full length over a short duration that scales with backlog.
// Result: even a sudden 500-char burst reveals smoothly within ~500 ms; a
// slow trickle stays in lockstep with arrival.
//
// While streaming we render plain text — Markdown reflows would jitter on
// every delta (code fences, headings appearing mid-render). On completion
// we cross-fade to the final Markdown render.
export function StreamingText({
  chunks,
  done,
}: {
  chunks: string[]
  done: boolean
}) {
  const reduce = useReducedMotion()
  const full = React.useMemo(() => chunks.join(""), [chunks])
  const [displayed, setDisplayed] = React.useState("")
  const visibleRef = React.useRef(0)

  React.useEffect(() => {
    if (done || reduce) {
      visibleRef.current = full.length
      setDisplayed(full)
      return
    }
    const from = Math.min(visibleRef.current, full.length)
    const to = full.length
    if (from >= to) return
    const backlog = to - from
    // Tween duration: ~200 chars/sec catch-up, capped so we never lag noticeably.
    const duration = Math.min(0.6, Math.max(0.05, backlog / 200))
    const controls = animate(from, to, {
      duration,
      ease: "linear",
      onUpdate: (v) => {
        const n = Math.floor(v)
        if (n !== visibleRef.current) {
          visibleRef.current = n
          setDisplayed(full.slice(0, n))
        }
      },
      onComplete: () => {
        visibleRef.current = to
        setDisplayed(full)
      },
    })
    return () => controls.stop()
  }, [full, done, reduce])

  if (done) {
    return (
      <motion.div
        key="md"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
      >
        <Markdown text={full} />
      </motion.div>
    )
  }

  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed font-sans text-foreground">
      {displayed}
      <Caret />
    </div>
  )
}

function Caret() {
  const reduce = useReducedMotion()
  return (
    <motion.span
      aria-hidden
      className="inline-block w-[2px] h-[1.05em] -mb-[3px] ml-[1px] bg-foreground/80 align-baseline rounded-[1px]"
      animate={reduce ? undefined : { opacity: [1, 0, 1] }}
      transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
    />
  )
}
