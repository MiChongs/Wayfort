// REST + SSE reverse proxy. The browser hits /api/proxy/api/v1/... → we
// forward to the Go backend at BACKEND_HTTP_URL, propagating Authorization,
// the original client IP (via X-Forwarded-For / X-Real-IP), and the request
// body. The response (including SSE streams) is piped straight back.
//
// WebSocket upgrades CANNOT pass through this handler — Next.js Route
// Handlers don't speak the upgrade protocol. WS endpoints are dialled
// directly by the browser using NEXT_PUBLIC_BACKEND_WS_URL.

import { NextRequest } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BACKEND = process.env.BACKEND_HTTP_URL || "http://127.0.0.1:8080"

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
])

function clientIPFromHeaders(req: NextRequest): string {
  // Order of preference: existing X-Forwarded-For chain (we append), then the
  // socket peer if Next.js handed it to us. Next.js exposes the remote addr
  // through the request.headers when running behind its own server too.
  const fwd = req.headers.get("x-forwarded-for")
  if (fwd) return fwd
  // Next.js 16 exposes req.ip in some runtimes; fall back to header.
  // @ts-expect-error - .ip is available at runtime
  return (req.ip as string | undefined) || req.headers.get("x-real-ip") || ""
}

function buildHeaders(req: NextRequest): Headers {
  const out = new Headers()
  for (const [k, v] of req.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue
    out.set(k, v)
  }
  const ip = clientIPFromHeaders(req)
  if (ip) {
    const existing = req.headers.get("x-forwarded-for")
    out.set("x-forwarded-for", existing ? `${existing}, ${ip}` : ip)
    out.set("x-real-ip", ip)
  }
  // Backend trusts X-Forwarded-Host for absolute URL construction.
  const proto = req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "")
  out.set("x-forwarded-proto", proto)
  out.set("x-forwarded-host", req.headers.get("host") || req.nextUrl.host)
  return out
}

async function pipe(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params
  const upstream = `${BACKEND}/${path.join("/")}${req.nextUrl.search}`
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: buildHeaders(req),
    redirect: "manual",
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body
    init.duplex = "half"
  }
  const res = await fetch(upstream, init)
  const out = new Headers(res.headers)
  // Avoid double-compression: Next.js may auto-encode; drop hop-by-hop.
  out.delete("transfer-encoding")
  out.delete("connection")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

export const GET = pipe
export const POST = pipe
export const PUT = pipe
export const PATCH = pipe
export const DELETE = pipe
export const OPTIONS = pipe
export const HEAD = pipe
