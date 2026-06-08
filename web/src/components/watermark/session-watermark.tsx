"use client"

// Scoped watermark for full-screen session surfaces (terminal, RDP/VNC, desktop).
//
// Why this exists: requestFullscreen() renders ONLY the fullscreen element and
// its subtree, so the global <body> overlay vanishes the moment a session goes
// fullscreen. Mounting a layer *inside* the session wrapper keeps the identity
// mark on screen exactly when it matters most (and on screenshots).
//
// To avoid a double-dark overlay, when scope === "all" we mount the scoped layer
// only while the wrapper is the active fullscreen element — outside fullscreen
// the body overlay already covers it. When scope === "session" the body overlay
// never exists, so the scoped layer is always mounted.

import * as React from "react"
import { useWatermarkRuntime } from "./watermark-context"
import { mountWatermark, type WatermarkEngine, type Surface } from "./engine"

function fullscreenElement(): Element | null {
  if (typeof document === "undefined") return null
  return (
    document.fullscreenElement ??
    (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement ??
    null
  )
}

/**
 * Mount a watermark on the element referenced by `targetRef`. The target should
 * be the same element the session calls requestFullscreen() on. Session surfaces
 * are dark, so the default surface is "dark" (the engine flips a dark configured
 * colour to a legible light one automatically).
 */
export function useWatermark(targetRef: React.RefObject<HTMLElement | null>, surface: Surface = "dark") {
  const runtime = useWatermarkRuntime()
  const [fsTick, setFsTick] = React.useState(0)

  React.useEffect(() => {
    const onChange = () => setFsTick((t) => t + 1)
    document.addEventListener("fullscreenchange", onChange)
    document.addEventListener("webkitfullscreenchange", onChange)
    return () => {
      document.removeEventListener("fullscreenchange", onChange)
      document.removeEventListener("webkitfullscreenchange", onChange)
    }
  }, [])

  React.useEffect(() => {
    const target = targetRef.current
    if (!target || !runtime?.enabled) return

    const fsEl = fullscreenElement()
    const inFullscreen = !!fsEl && (fsEl === target || fsEl.contains(target) || target.contains(fsEl))
    // scope "all" + not fullscreen → the body overlay already covers this; skip.
    if (runtime.scope !== "session" && !inFullscreen) return

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
  }, [targetRef, runtime, surface, fsTick])
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
