// Front-end API client. All requests go through the Next.js proxy at
// /api/proxy/api/v1/... — never directly to the backend host — so cookies and
// IP forwarding stay coherent. WebSocket connections do not use this; see
// lib/ws/* for those.

import { getAccessToken, clearTokens } from "@/lib/auth/tokens"

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api/proxy/api/v1"

export type ApiError = {
  status: number
  message: string
  detail?: unknown
}

function buildURL(path: string, query?: Record<string, string | number | boolean | undefined>) {
  const url = path.startsWith("http") ? new URL(path) : new URL(API_BASE + path, window.location.origin)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

type Options = {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  headers?: Record<string, string>
  raw?: boolean
}

export async function api<T>(method: string, path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers || {}) }
  const tok = getAccessToken()
  if (tok) headers.Authorization = `Bearer ${tok}`
  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) {
      body = opts.body
    } else {
      headers["Content-Type"] = headers["Content-Type"] || "application/json"
      body = JSON.stringify(opts.body)
    }
  }
  const res = await fetch(buildURL(path, opts.query), {
    method,
    headers,
    body,
    credentials: "include",
  })
  if (res.status === 401) {
    clearTokens()
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login"
    }
  }
  if (!res.ok) {
    let detail: unknown = undefined
    let message = res.statusText
    try {
      const text = await res.text()
      try {
        detail = JSON.parse(text)
        if (detail && typeof detail === "object" && "error" in (detail as Record<string, unknown>)) {
          message = String((detail as Record<string, unknown>).error)
        }
      } catch {
        message = text || message
      }
    } catch {
      // ignore
    }
    const err: ApiError = { status: res.status, message, detail }
    throw err
  }
  if (opts.raw) return res as unknown as T
  if (res.status === 204) return undefined as T
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("application/json")) return (await res.json()) as T
  return (await res.text()) as unknown as T
}

export function buildURLFromAPI(path: string, query?: Record<string, string | number | undefined>) {
  if (typeof window === "undefined") return API_BASE + path
  return buildURL(path, query)
}

// Some asset endpoints (asciinema recording, SFTP download) are consumed by
// the browser as plain URLs — via <a href>, <video src>, or third-party
// players like asciinema-player that don't accept custom headers. For those
// we append the access token as a query string; the backend's middleware
// (extractToken) already honours ?token=.
export function withTokenQuery(url: string): string {
  const tok = getAccessToken()
  if (!tok) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(tok)}`
}
