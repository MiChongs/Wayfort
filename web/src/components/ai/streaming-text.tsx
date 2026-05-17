"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Markdown } from "./markdown"

// Claude.ai-style streaming: render Markdown progressively, no per-chunk fade,
// no "done" cross-fade. The text simply grows in place as SSE arrives; when
// streaming stops, the only thing that changes is the caret disappears. This
// matches Anthropic's chat UI feel and eliminates the jarring "second
// animation" the user reported.
//
// Performance: ReactMarkdown + remark-gfm + rehype-highlight + rehype-katex
// is heavy. At 60 fps a long response (~10k chars) noticeably lags on mid-
// range laptops. We throttle re-renders to ≤30 fps during streaming via a
// `setTimeout(…, 33)` debouncer that always catches up to the latest text
// before the next paint. Once `done` flips true, we flush synchronously so
// the final state is correct.
//
// Markdown component itself is memoised so identical text doesn't trigger a
// re-parse — only growth does.
export function StreamingText({
  chunks,
  done,
}: {
  chunks: string[]
  done: boolean
}) {
  const reduce = useReducedMotion()
  const full = React.useMemo(() => chunks.join(""), [chunks])
  const [displayed, setDisplayed] = React.useState(full)
  const pendingRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    // Cancel any pending throttle when input changes / unmount.
    return () => {
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current)
        pendingRef.current = null
      }
    }
  }, [])

  React.useEffect(() => {
    // Always commit synchronously when finishing — no animation on done.
    if (done || reduce) {
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current)
        pendingRef.current = null
      }
      setDisplayed(full)
      return
    }
    // Already at the latest? nothing to do.
    if (displayed === full) return
    if (pendingRef.current !== null) return // a flush is already queued
    pendingRef.current = window.setTimeout(() => {
      pendingRef.current = null
      setDisplayed(full)
    }, 33)
  }, [full, done, reduce, displayed])

  return (
    <div className="ai-streaming-text relative">
      <Markdown text={displayed} />
      {!done && <Caret reduce={reduce ?? false} />}
    </div>
  )
}

// Caret is a tiny inline-block bar that follows the last rendered text. We
// keep it as a sibling rather than injecting into the Markdown AST: simpler,
// and the visual offset is unobtrusive enough. motion handles the blink so
// we don't need a global CSS keyframe.
function Caret({ reduce }: { reduce: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="inline-block w-[7px] h-[14px] -mb-[2px] ml-[2px] bg-foreground/85 align-baseline rounded-[1.5px]"
      animate={reduce ? undefined : { opacity: [1, 0, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
    />
  )
}
