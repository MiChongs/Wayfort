"use client"

import { useQuery } from "@tanstack/react-query"
import { meService } from "@/lib/api/services"
import type { AccessTier } from "@/lib/api/types"
import { useCurrentUser } from "./use-current-user"

// useAccess resolves the caller's role tier (superadmin / admin / user) from the
// server, which is the single source of truth for dashboard + nav gating. While
// the request is in flight it falls back to the JWT `adm` flag so the chrome
// never flickers blank for a known-admin.
export function useAccess() {
  const me = useCurrentUser()
  const q = useQuery({
    queryKey: ["me", "access"],
    queryFn: meService.access,
    enabled: !!me,
    staleTime: 5 * 60 * 1000,
  })

  const fallbackTier: AccessTier = me?.adm ? "admin" : "user"
  const tier: AccessTier = q.data?.tier ?? fallbackTier

  return {
    tier,
    isSuperadmin: q.data?.is_superadmin ?? false,
    isAdmin: q.data?.is_admin ?? me?.adm === true,
    permissions: q.data?.permissions ?? [],
    loading: q.isLoading && !!me,
  }
}

// Numeric rank for "at least this tier" comparisons.
export function tierRank(t: AccessTier): number {
  return t === "superadmin" ? 2 : t === "admin" ? 1 : 0
}
