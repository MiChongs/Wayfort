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
import type { WatermarkSessionContext } from "@/lib/api/types"

/**
 * Mount a watermark on the element referenced by `targetRef`. The target should
 * be the element the session calls requestFullscreen() on, so the layer follows
 * it into fullscreen. Defaults to the "dark" surface (the engine keeps the mark
 * legible by flipping a too-dark configured colour to a light one).
 *
 * `sessionCtx` carries the live connection's asset/host/session so the engine can
 * fill the {asset}/{host}/{session} tokens (when the admin enabled session vars).
 * Plain pages (the global body overlay) pass none → those tokens clear away.
 */
export function useWatermark(
  targetRef: React.RefObject<HTMLElement | null>,
  surface: Surface = "dark",
  sessionCtx?: WatermarkSessionContext,
) {
  const runtime = useWatermarkRuntime()
  // Stable signature so the effect re-runs only when a token value actually changes.
  const ctxKey = `${sessionCtx?.asset ?? ""}|${sessionCtx?.host ?? ""}|${sessionCtx?.session ?? ""}`

  React.useEffect(() => {
    const target = targetRef.current
    if (!target || !runtime?.enabled) return

    let engine: WatermarkEngine | null = null
    let cancelled = false
    void mountWatermark(target, runtime, surface, sessionCtx).then((e) => {
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
    // ctxKey stands in for sessionCtx (object identity would re-run every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef, runtime, surface, ctxKey])
}

/** Declarative wrapper around useWatermark for session components. Renders nothing. */
export function SessionWatermark({
  targetRef,
  surface = "dark",
  sessionCtx,
}: {
  targetRef: React.RefObject<HTMLElement | null>
  surface?: Surface
  sessionCtx?: WatermarkSessionContext
}) {
  useWatermark(targetRef, surface, sessionCtx)
  return null
}
