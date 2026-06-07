"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Heart, Search, Server, ShieldCheck } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/common/empty-state"
import { TagBadge } from "@/components/tags/tag-badge"
import { meService } from "@/lib/api/services"
import type { Node } from "@/lib/api/types"
import { AppIcon } from "@/components/icons/app-icon"
import { nodeIcon } from "@/lib/icons/protocol"
import { cn } from "@/lib/utils"

export default function NodesPage() {
  const qc = useQueryClient()
  const [q, setQ] = React.useState("")
  const [proto, setProto] = React.useState<string | null>(null)
  const [region, setRegion] = React.useState<string | null>(null)
  const [tag, setTag] = React.useState<string | null>(null)
  const [onlyFav, setOnlyFav] = React.useState(false)

  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const fav = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })

  const toggleFav = useMutation({
    mutationFn: async ({ id, current }: { id: number; current: boolean }) =>
      current ? meService.removeFavorite(id) : meService.addFavorite(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "favorites"] }),
    onError: (e: unknown) => toast.error("操作失败", { description: (e as Error).message }),
  })

  const favSet = new Set(fav.data?.node_ids || [])
  const all = nodes.data?.nodes || []

  const protos = React.useMemo(() => facetCount(all, (n) => n.protocol), [all])
  const regions = React.useMemo(() => facetCount(all, (n) => n.region || ""), [all])
  const tagFacets = React.useMemo(
    () =>
      facetCount(all, (n) => n.tags || "", (raw) =>
        raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    [all],
  )

  const filtered = all.filter((n) => {
    if (onlyFav && !favSet.has(n.id)) return false
    if (proto && n.protocol !== proto) return false
    if (region && n.region !== region) return false
    if (tag) {
      const list = (n.tags || "").split(",").map((x) => x.trim())
      if (!list.includes(tag)) return false
    }
    if (q) {
      const s = q.toLowerCase()
      const hay = [n.name, n.host, n.description, n.tags, n.protocol].filter(Boolean).join(" ").toLowerCase()
      if (!hay.includes(s)) return false
    }
    return true
  })

  const clearAll = () => {
    setProto(null)
    setRegion(null)
    setTag(null)
    setOnlyFav(false)
  }
  const hasFilter = !!(proto || region || tag || onlyFav)

  return (
    <div className="flex flex-col gap-6 p-6 lg:flex-row">
      {/* Facet panel */}
      <aside className="shrink-0 space-y-5 lg:w-56">
        <div>
          <h1 className="display-title text-2xl">节点</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {nodes.data?.scope === "all" ? "全部资产" : "已授权资产"} · {all.length} 个
          </p>
        </div>

        <FacetGroup title="快速">
          <FacetRow label="全部资产" active={!hasFilter} count={all.length} onClick={clearAll} />
          <FacetRow
            label="我的收藏"
            icon={Heart}
            active={onlyFav}
            count={favSet.size}
            onClick={() => setOnlyFav((v) => !v)}
          />
        </FacetGroup>

        {protos.length > 0 && (
          <FacetGroup title="协议">
            {protos.map(([p, c]) => (
              <FacetRow
                key={p}
                label={p.toUpperCase()}
                count={c}
                active={proto === p}
                onClick={() => setProto(proto === p ? null : p)}
              />
            ))}
          </FacetGroup>
        )}

        {regions.length > 0 && (
          <FacetGroup title="区域">
            {regions.map(([r, c]) => (
              <FacetRow key={r} label={r} count={c} active={region === r} onClick={() => setRegion(region === r ? null : r)} />
            ))}
          </FacetGroup>
        )}

        {tagFacets.length > 0 && (
          <FacetGroup title="标签">
            {tagFacets.slice(0, 12).map(([t, c]) => (
              <FacetRow key={t} label={t} count={c} active={tag === t} onClick={() => setTag(tag === t ? null : t)} />
            ))}
          </FacetGroup>
        )}
      </aside>

      {/* Content */}
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex items-center gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称 / 主机 / 标签…" className="pl-9" />
          </div>
          <span className="ml-auto text-xs text-muted-foreground">
            {hasFilter || q ? `匹配 ${filtered.length} / ${all.length}` : `共 ${all.length} 个`}
          </span>
        </div>

        {filtered.length === 0 && !nodes.isLoading ? (
          <div className="rounded-xl border bg-card">
            <EmptyState
              icon={Server}
              title="没有匹配的节点"
              description={q || hasFilter ? "试试调整搜索或筛选条件。" : "暂无已授权的资产，请联系管理员授权。"}
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((n) => (
              <NodeCard
                key={n.id}
                node={n}
                fav={favSet.has(n.id)}
                onToggleFav={() => toggleFav.mutate({ id: n.id, current: favSet.has(n.id) })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function NodeCard({ node: n, fav, onToggleFav }: { node: Node; fav: boolean; onToggleFav: () => void }) {
  // Prefer managed colour tags; fall back to the freetext cache for nodes not
  // yet migrated.
  const managed = n.tag_list || []
  const freetext = (n.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  const needsApproval = n.requires_approval_for_connect || n.requires_approval_for_file_xfer
  return (
    <Card className="group gap-0 p-4 transition-colors hover:border-primary/40">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/nodes/${n.id}` as Parameters<typeof Link>[0]["href"]} className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
            <AppIcon icon={nodeIcon(n)} size={18} />
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium group-hover:text-primary">{n.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {n.host}:{n.port}
            </div>
          </div>
        </Link>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 shrink-0", fav && "text-red-500")}
          onClick={onToggleFav}
          aria-label={fav ? "取消收藏" : "收藏"}
        >
          <Heart className={cn("h-4 w-4", fav && "fill-current")} />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant="soft" className="font-mono text-[10px]">
          {n.protocol.toUpperCase()}
        </Badge>
        {n.region && (
          <Badge variant="outline" className="rounded-full font-normal">
            {n.region}
          </Badge>
        )}
        {managed.length > 0
          ? managed.slice(0, 3).map((t) => (
              <TagBadge key={t.id} tag={t} size="sm" showDot />
            ))
          : freetext.slice(0, 3).map((t) => (
              <Badge key={t} variant="outline" className="rounded-full font-normal">
                {t}
              </Badge>
            ))}
        {needsApproval && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-amber-600 dark:text-amber-400" title="访问需审批">
            <ShieldCheck className="h-3 w-3" /> 需审批
          </span>
        )}
        {n.disabled && (
          <Badge variant="outline" className="rounded-full font-normal text-muted-foreground">
            已停用
          </Badge>
        )}
      </div>

      {n.description && <p className="mt-2.5 line-clamp-2 text-xs text-muted-foreground">{n.description}</p>}
    </Card>
  )
}

// FacetGroup / FacetRow — the left filter panel.

function FacetGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="eyebrow px-1.5">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function FacetRow({
  label,
  count,
  active,
  icon: Icon,
  onClick,
}: {
  label: string
  count?: number
  active?: boolean
  icon?: React.ComponentType<{ className?: string }>
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active ? "bg-primary/12 font-medium text-primary" : "text-foreground/80 hover:bg-accent",
      )}
    >
      {Icon && <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} />}
      <span className="truncate">{label}</span>
      {count != null && (
        <span className={cn("ml-auto text-xs tabular-nums", active ? "text-primary/70" : "text-muted-foreground")}>{count}</span>
      )}
    </button>
  )
}

function facetCount(
  nodes: Node[],
  pick: (n: Node) => string,
  expand?: (raw: string) => string[],
): [string, number][] {
  const m = new Map<string, number>()
  for (const n of nodes) {
    const raw = pick(n)
    const keys = expand ? expand(raw) : raw ? [raw] : []
    for (const k of keys) m.set(k, (m.get(k) || 0) + 1)
  }
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
}
