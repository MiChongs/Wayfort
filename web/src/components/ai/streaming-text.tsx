"use client"

import * as React from "react"
import { useReducedMotion } from "motion/react"
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
    // The coral streaming caret is a pseudo-element pinned to the END of the
    // last rendered block (see `.ai-streaming-text[data-streaming] … ::after`
    // in globals.css) so it sits INLINE after the final word — the Claude.ai
    // feel — instead of dropping onto its own line beneath the prose.
    <div className="ai-streaming-text relative" data-streaming={done ? undefined : "true"}>
      <Markdown text={displayed} />
    </div>
  )
}
