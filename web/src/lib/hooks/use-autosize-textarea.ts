"use client"

import * as React from "react"

export function useAutosizeTextarea(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight = 240,
) {
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "0px"
    const h = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${h}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden"
  }, [ref, value, maxHeight])
}
