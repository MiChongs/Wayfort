"use client"

import * as React from "react"
import { currentClaims, type Claims } from "@/lib/auth/tokens"

export function useCurrentUser(): Claims | null {
  const [claims, setClaims] = React.useState<Claims | null>(() => currentClaims())
  React.useEffect(() => {
    const handler = () => setClaims(currentClaims())
    window.addEventListener("storage", handler)
    window.addEventListener("focus", handler)
    return () => {
      window.removeEventListener("storage", handler)
      window.removeEventListener("focus", handler)
    }
  }, [])
  return claims
}
