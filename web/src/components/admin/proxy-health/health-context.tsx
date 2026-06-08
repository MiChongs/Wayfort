"use client"

import * as React from "react"
import { useProxyHealth, type ProxyHealthView } from "@/lib/hooks/use-proxy-health"

// Inert view returned when a consumer is used outside a provider — keeps every
// HealthDot callable (resolving to "unknown") instead of crashing.
const INERT: ProxyHealthView = {
  byId: () => undefined,
  snapshot: undefined,
  status: "idle",
  sampledAt: null,
}

const Ctx = React.createContext<ProxyHealthView | null>(null)

/**
 * ProxyHealthProvider opens a single proxy-health SSE subscription at a tree
 * root (the proxy-chain center, the chain builder, …). Every descendant
 * HealthDot / hop / canvas node reads it via useProxyHealthCtx, so we never
 * fan out N live connections for one page.
 */
export function ProxyHealthProvider({
  children,
  enabled = true,
}: {
  children: React.ReactNode
  enabled?: boolean
}) {
  const view = useProxyHealth({ enabled })
  return <Ctx.Provider value={view}>{children}</Ctx.Provider>
}

export function useProxyHealthCtx(): ProxyHealthView {
  return React.useContext(Ctx) ?? INERT
}
