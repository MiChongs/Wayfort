"use client"

import { useQuery } from "@tanstack/react-query"
import { meService } from "@/lib/api/services"
import type { EditionFeature, EditionInfo } from "@/lib/api/types"
import { useCurrentUser } from "./use-current-user"

// useEdition resolves the gateway's current edition + which paid features are
// unlocked. It's the frontend single source of truth for hiding/locking
// edition-gated nav and surfacing the upsell/expiry banner. The real
// enforcement is server-side (the feat() route middleware) — this is cosmetic.
export function useEdition() {
  const me = useCurrentUser()
  const q = useQuery({
    queryKey: ["me", "edition"],
    queryFn: meService.edition,
    enabled: !!me,
    staleTime: 5 * 60 * 1000,
  })

  const data = q.data
  const has = (f: EditionFeature): boolean => data?.features?.[f] === true

  return {
    edition: data?.edition ?? "community",
    state: data?.state ?? "community",
    features: data?.features ?? {},
    info: data as EditionInfo | undefined,
    has,
    // A non-fatal banner is warranted when a license is degraded/expiring.
    needsAttention: data?.state === "grace" || data?.state === "expired" || data?.state === "invalid",
    loading: q.isLoading && !!me,
  }
}
