// Token storage layer. We use localStorage for the access token (so a page
// reload keeps you logged in) and parse the JWT payload on demand to feed
// useCurrentUser / permission checks.

const ACCESS_KEY = "wayfort:access"
const REFRESH_KEY = "wayfort:refresh"

export type Claims = {
  uid: number
  usr: string
  adm?: boolean
  anon?: boolean
  step?: "" | "mfa_required" | "refresh"
  exp: number
  iat: number
  sub: string
  jti: string
  mfa_methods?: string[]
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(ACCESS_KEY)
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem(REFRESH_KEY)
}

export function setTokens(access: string, refresh?: string) {
  if (typeof window === "undefined") return
  localStorage.setItem(ACCESS_KEY, access)
  if (refresh) localStorage.setItem(REFRESH_KEY, refresh)
}

export function clearTokens() {
  if (typeof window === "undefined") return
  localStorage.removeItem(ACCESS_KEY)
  localStorage.removeItem(REFRESH_KEY)
}

export function parseClaims(token: string | null): Claims | null {
  if (!token) return null
  try {
    const parts = token.split(".")
    if (parts.length < 2) return null
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    return JSON.parse(json) as Claims
  } catch {
    return null
  }
}

export function currentClaims(): Claims | null {
  return parseClaims(getAccessToken())
}

export function isAuthenticated(): boolean {
  const c = currentClaims()
  if (!c) return false
  if (c.step) return false
  if (c.exp && c.exp * 1000 < Date.now()) return false
  return true
}
