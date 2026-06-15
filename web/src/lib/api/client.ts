// Front-end API client. All requests go through the Next.js proxy at
// /api/proxy/api/v1/... — never directly to the backend host — so cookies and
// IP forwarding stay coherent. WebSocket connections do not use this; see
// lib/ws/* for those.

import { getAccessToken, getRefreshToken, setTokens, clearTokens, isAuthenticated } from "@/lib/auth/tokens"

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

// ----- access-token refresh ------------------------------------------------
// The access token is short-lived (default 1h) while the refresh token lasts
// days. Nothing used to spend the refresh token, so a logged-in user was
// bounced to /login the instant the access token lapsed — the "login expires
// too soon" symptom. We now transparently mint a fresh access token from the
// refresh token: reactively (retry once on a 401) and proactively (the auth
// session hook calls these on mount + a keep-alive timer).
//
// Single-flight: a burst of parallel requests that all 401 at once share one
// /auth/refresh round-trip instead of stampeding it.
let refreshInFlight: Promise<boolean> | null = null

export function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  const refresh = getRefreshToken()
  if (!refresh) return Promise.resolve(false)
  refreshInFlight = (async () => {
    try {
      const res = await fetch(buildURL("/auth/refresh"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
        credentials: "include",
      })
      if (!res.ok) return false
      const pair = (await res.json()) as { access_token?: string; refresh_token?: string }
      if (!pair?.access_token) return false
      setTokens(pair.access_token, pair.refresh_token)
      return true
    } catch {
      return false
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

// Returns true when a usable access token is in hand — either the current one
// is still valid, or it was just refreshed. Returns false only when there's no
// path back to an authenticated state (no / expired / revoked refresh token);
// the caller should then redirect to /login.
export async function ensureValidAccessToken(): Promise<boolean> {
  if (isAuthenticated()) return true
  return refreshAccessToken()
}

function redirectToLogin() {
  clearTokens()
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login"
  }
}

export async function api<T>(method: string, path: string, opts: Options = {}, _retried = false): Promise<T> {
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
    // Recover a lapsed session once before giving up: refresh the access token
    // and replay the request. Never recurse on the refresh endpoint itself, and
    // only ever retry a single time.
    if (!_retried && !path.startsWith("/auth/refresh") && (await refreshAccessToken())) {
      return api<T>(method, path, opts, true)
    }
    redirectToLogin()
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

// fetch() has no upload-progress events; for the SFTP transfer drawer we need
// per-file bytes-sent updates and per-file abort. apiUpload wraps XHR so
// callers get an `onProgress` callback plus an AbortSignal that cancels the
// in-flight request. Response handling mirrors api() (JSON 200, structured
// ApiError on non-2xx, automatic /login redirect on 401).
export type UploadOptions = {
  query?: Record<string, string | number | boolean | undefined>
  fieldName?: string
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
}

export function apiUpload<T>(path: string, file: File | Blob, opts: UploadOptions = {}, _retried = false): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = buildURL(path, opts.query)
    const xhr = new XMLHttpRequest()
    xhr.open("POST", url, true)
    xhr.withCredentials = true
    const tok = getAccessToken()
    if (tok) xhr.setRequestHeader("Authorization", `Bearer ${tok}`)
    xhr.responseType = "text"

    if (opts.onProgress) {
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) opts.onProgress!(ev.loaded, ev.total)
      }
    }

    const onAbort = () => xhr.abort()
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject({ status: 0, message: "aborted" } as ApiError)
        return
      }
      opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    xhr.onerror = () => {
      opts.signal?.removeEventListener("abort", onAbort)
      reject({ status: xhr.status || 0, message: "network error" } as ApiError)
    }
    xhr.onabort = () => {
      opts.signal?.removeEventListener("abort", onAbort)
      reject({ status: 0, message: "aborted" } as ApiError)
    }
    xhr.onload = () => {
      opts.signal?.removeEventListener("abort", onAbort)
      const status = xhr.status
      const text = xhr.responseText
      if (status === 401) {
        // Mirror api(): try one refresh + replay before bouncing to /login.
        if (!_retried) {
          refreshAccessToken().then((ok) => {
            if (ok) {
              resolve(apiUpload<T>(path, file, opts, true))
            } else {
              redirectToLogin()
              reject({ status, message: "unauthorized" } as ApiError)
            }
          })
          return
        }
        redirectToLogin()
      }
      if (status >= 200 && status < 300) {
        if (!text) {
          resolve(undefined as T)
          return
        }
        try {
          resolve(JSON.parse(text) as T)
        } catch {
          resolve(text as unknown as T)
        }
        return
      }
      let detail: unknown = undefined
      let message = xhr.statusText || `HTTP ${status}`
      try {
        detail = JSON.parse(text)
        if (detail && typeof detail === "object" && "error" in (detail as Record<string, unknown>)) {
          message = String((detail as Record<string, unknown>).error)
        }
      } catch {
        if (text) message = text
      }
      reject({ status, message, detail } as ApiError)
    }

    const fd = new FormData()
    fd.append(opts.fieldName || "file", file)
    xhr.send(fd)
  })
}
