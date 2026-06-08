"use client"

// WatermarkProvider fetches the per-user watermark policy once (cached, refetched
// on window focus so a super-admin change propagates without a reload) and:
//   • paints the global <body> overlay when scope === "all";
//   • exposes the runtime via context so full-screen session views can mount
//     their own scoped layer (see session-watermark.tsx).
//
// It renders no visible DOM of its own — only children pass through.

import * as React from "react"
import { useTheme } from "next-themes"
import { useQuery } from "@tanstack/react-query"
import { meService } from "@/lib/api/services"
import type { WatermarkRuntime } from "@/lib/api/types"
import { mountWatermark, type WatermarkEngine } from "./engine"

const WatermarkContext = React.createContext<WatermarkRuntime | null>(null)

/** The resolved watermark runtime for the current user, or null while loading. */
export function useWatermarkRuntime(): WatermarkRuntime | null {
  return React.useContext(WatermarkContext)
}

export function WatermarkProvider({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme()
  const { data } = useQuery({
    queryKey: ["me", "watermark"],
    queryFn: meService.watermark,
    staleTime: 3 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })

  const runtime = data ?? null

  // Global overlay on <body>. Skipped for scope "session" (those pages get the
  // overlay only inside the session wrapper). Re-mounts on policy/theme change
  // so colour adapts to light/dark and edits apply on the next focus refetch.
  React.useEffect(() => {
    if (typeof document === "undefined") return
    if (!runtime?.enabled || runtime.scope === "session") return
    let engine: WatermarkEngine | null = null
    let cancelled = false
    void mountWatermark(document.body, runtime, "auto").then((e) => {
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
  }, [runtime, resolvedTheme])

  return <WatermarkContext.Provider value={runtime}>{children}</WatermarkContext.Provider>
}
