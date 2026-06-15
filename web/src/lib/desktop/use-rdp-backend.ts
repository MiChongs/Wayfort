"use client"

import { useQuery } from "@tanstack/react-query"
import { desktopControl } from "./control-client"
import type { DesktopBackend } from "./types"

/**
 * useRdpBackendPreference resolves which RDP backend the workspace should
 * default to, based on what the server can actually serve right now
 * (GET /desktop/stats):
 *
 *   - prefer the server's configured default_backend when that backend is ready,
 *   - else whichever backend IS ready (ironrdp ⇐ Devolutions Gateway healthy,
 *     freerdp ⇐ worker bootstrapped),
 *   - else fall back to the configured default so the UI still offers it and any
 *     real error surfaces on connect.
 *
 * Returns undefined while loading (callers keep the static order until then).
 * React Query dedupes the request across every tree node that calls this.
 */
export function useRdpBackendPreference(): DesktopBackend | undefined {
  const { data } = useQuery({
    queryKey: ["desktop", "stats"],
    queryFn: desktopControl.stats,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  })
  if (!data) return undefined

  const def = data.default_backend
  const gwReady = !!data.devolutions_gateway?.ready
  const workerReady = !!data.worker_ready

  if (def === "ironrdp" && gwReady) return "ironrdp"
  if (def === "freerdp" && workerReady) return "freerdp"
  if (gwReady) return "ironrdp"
  if (workerReady) return "freerdp"
  return def === "ironrdp" || def === "freerdp" ? def : undefined
}
