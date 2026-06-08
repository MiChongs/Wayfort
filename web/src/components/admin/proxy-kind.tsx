import { ArrowRight, Globe, GitFork, Network, Server, Waypoints } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ProxyKind } from "@/lib/api/types"

// Single source of truth for how each proxy kind is labelled / iconed / tinted.
// DESIGN.md: coral-only + warm semantic — categorical kinds are differentiated by
// ICON, not by cool per-kind colors (the old sky/emerald/amber palette is gone).
// Surfaces stay warm-neutral; coral (primary) is reserved for the composite
// failover kind, the hop index pill, and CTAs.

export const KIND_LABEL: Record<ProxyKind, string> = {
  direct: "Direct",
  socks5: "SOCKS5",
  socks4: "SOCKS4",
  bastion: "SSH 跳板",
  http_connect: "HTTP CONNECT",
  failover: "故障转移组",
}

export const KIND_ICON: Record<ProxyKind, LucideIcon> = {
  direct: ArrowRight,
  socks5: Network,
  socks4: Waypoints,
  bastion: Server,
  http_connect: Globe,
  failover: GitFork,
}

export const KIND_TONE: Record<ProxyKind, string> = {
  direct: "bg-muted text-muted-foreground border-border",
  socks5: "bg-accent text-foreground border-border",
  socks4: "bg-accent text-foreground border-border",
  bastion: "bg-secondary text-foreground border-border",
  http_connect: "bg-accent text-foreground border-border",
  failover: "bg-primary/10 text-primary border-primary/30",
}

export function kindLabel(k: ProxyKind | string): string {
  return KIND_LABEL[k as ProxyKind] ?? String(k)
}
