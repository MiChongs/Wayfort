"use client"

// Scoped watermark for session surfaces (terminal, RDP/VNC, desktop).
//
// Session surfaces are dark islands that may sit inside a light-themed app, and
// they go full-screen via requestFullscreen() (which renders ONLY the
// fullscreen element + its subtree). Both facts mean the global <body> overlay
// can't be relied on here:
//   • its colour is chosen for the APP theme, so a dark-on-dark app would make
//     it invisible over a dark terminal;
//   • it disappears entirely the moment the surface goes fullscreen.
//
// So we always mount a layer *inside* the session wrapper, colour-adapted for a
// dark surface. In the common light-theme app the body overlay's dark text is
// invisible over the dark terminal, so there's no visible double; this layer is
// the one the user actually sees on the session (and on any screenshot/record).

import * as React from "react"
import { useWatermarkRuntime } from "./watermark-context"
import { mountWatermark, type WatermarkEngine, type Surface } from "./engine"

/**
 * Mount a watermark on the element referenced by `targetRef`. The target should
 * be the element the session calls requestFullscreen() on, so the layer follows
 * it into fullscreen. Defaults to the "dark" surface (the engine keeps the mark
 * legible by flipping a too-dark configured colour to a light one).
 */
export function useWatermark(targetRef: React.RefObject<HTMLElement | null>, surface: Surface = "dark") {
  const runtime = useWatermarkRuntime()

  React.useEffect(() => {
    const target = targetRef.current
    if (!target || !runtime?.enabled) return

    let engine: WatermarkEngine | null = null
    let cancelled = false
    void mountWatermark(target, runtime, surface).then((e) => {
      if (cancelled) {
        e?.destroy()
        return
      }
      engine = e
    })
    return () => {
      cancelled = true
      engine?.destroy()
    }
  }, [targetRef, runtime, surface])
}

/** Declarative wrapper around useWatermark for session components. Renders nothing. */
export function SessionWatermark({
  targetRef,
  surface = "dark",
}: {
  targetRef: React.RefObject<HTMLElement | null>
  surface?: Surface
}) {
  useWatermark(targetRef, surface)
  return null
}
