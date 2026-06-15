"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { currentClaims, getRefreshToken, isAuthenticated } from "@/lib/auth/tokens"
import { ensureValidAccessToken, refreshAccessToken } from "@/lib/api/client"

// Auth gate for the (app) and (workspace) route groups. The old gate called the
// synchronous isAuthenticated() and bounced to /login the moment the 1h access
// token expired — even though the refresh token is good for days. This hook
// instead:
//   1. On mount, ensures a usable access token (refreshing from the refresh
//      token if the access one has lapsed) before rendering the app.
//   2. Keeps the token fresh on a timer so long-lived surfaces (an open
//      terminal / desktop, whose WS auth reads the token directly and never
//      hits the 401-retry path) always have a valid token for the next
//      (re)connect.
// Only a genuinely dead session (no / expired / revoked refresh token) redirects
// to /login.

// Refresh this far ahead of the access token's expiry.
const REFRESH_SKEW_MS = 60_000
// Never schedule a tighter loop than this, even if exp is already near.
const MIN_DELAY_MS = 15_000

export function useAuthSession(): boolean {
  const router = useRouter()
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const bounce = () => {
      if (!cancelled) router.replace("/login")
    }

    const schedule = () => {
      const c = currentClaims()
      if (!c?.exp) return
      const ms = c.exp * 1000 - Date.now() - REFRESH_SKEW_MS
      timer = setTimeout(keepAlive, Math.max(MIN_DELAY_MS, ms))
    }

    const keepAlive = async () => {
      if (getRefreshToken()) {
        const ok = await refreshAccessToken()
        if (cancelled) return
        // Renewal failed and the access token is already gone → session over.
        if (!ok && !isAuthenticated()) {
          bounce()
          return
        }
      } else if (!isAuthenticated()) {
        bounce()
        return
      }
      schedule()
    }

    ;(async () => {
      const ok = await ensureValidAccessToken()
      if (cancelled) return
      if (!ok) {
        bounce()
        return
      }
      setReady(true)
      schedule()
    })()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [router])

  return ready
}
