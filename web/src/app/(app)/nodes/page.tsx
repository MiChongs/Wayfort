"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Database, Heart, Monitor, Search, Server, Terminal, X,
} from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { meService, tagService } from "@/lib/api/services"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/common/empty-state"
import type { NodeProtocol } from "@/lib/api/types"
import { cn } from "@/lib/utils"

const PROTOCOL_ICON: Record<NodeProtocol, React.ComponentType<{ className?: string }>> = {
  ssh: Terminal,
  telnet: Terminal,
  rdp: Monitor,
  vnc: Monitor,
  mysql: Database,
  postgres: Database,
  redis: Database,
  mongo: Database,
  tcp: Server,
}

export default function NodesPage() {
  const qc = useQueryClient()
  const [q, setQ] = React.useState("")
  const [proto, setProto] = React.useState<string | null>(null)
  const [region, setRegion] = React.useState<string | null>(null)
  const [tag, setTag] = React.useState<string | null>(null)
  const [onlyFav, setOnlyFav] = React.useState(false)

  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const fav = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })
  const tags = useQuery({ queryKey: ["admin", "tags"], queryFn: tagService.list })

  const toggleFav = useMutation({
    mutationFn: async ({ id, current }: { id: number; current: boolean }) =>
      current ? meService.removeFavorite(id) : meService.addFavorite(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "favorites"] }),
    onError: (e: unknown) => toast.error("操作失败", { description: (e as Error).message }),
  })

  const favSet = new Set(fav.data?.node_ids || [])
  const all = nodes.data?.nodes || []

  // Build filter facets (protocols, regions, tag list).
  const protos = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const n of all) m.set(n.protocol, (m.get(n.protocol) || 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [all])
  const regions = React.useMemo(() => {
    const s = new Set<string>()
    for (const n of all) if (n.region) s.add(n.region)
    return Array.from(s).sort()
  }, [all])

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

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">节点</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {nodes.data?.scope === "all" ? "全部资产" : "已授权访问的资产"} · 共 {all.length} 个 ·
            筛选后 <span className="text-foreground font-medium">{filtered.length}</span> 个
          </p>
        </div>
        <div className="relative w-64 max-w-full">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 name / host / tag" className="pl-8" />
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <Chip on={!proto && !region && !tag && !onlyFav} onClick={() => { setProto(null); setRegion(null); setTag(null); setOnlyFav(false) }}>
          全部
        </Chip>
        <Chip on={onlyFav} onClick={() => setOnlyFav(!onlyFav)}>
          <Heart className="w-3 h-3" /> 收藏
        </Chip>
        {protos.length > 0 && <span className="text-muted-foreground ml-2">协议：</span>}
        {protos.map(([p, n]) => (
          <Chip key={p} on={proto === p} onClick={() => setProto(proto === p ? null : p)}>
            {p.toUpperCase()} <span className="opacity-60">({n})</span>
          </Chip>
        ))}
        {regions.length > 0 && <span className="text-muted-foreground ml-2">区域：</span>}
        {regions.map((r) => (
          <Chip key={r} on={region === r} onClick={() => setRegion(region === r ? null : r)}>
            {r}
          </Chip>
        ))}
        {(tags.data?.tags?.length ?? 0) > 0 && <span className="text-muted-foreground ml-2">标签：</span>}
        {(tags.data?.tags || []).map((t) => (
          <Chip key={t.id} on={tag === t.name} onClick={() => setTag(tag === t.name ? null : t.name)}>
            {t.name}
          </Chip>
        ))}
        {(proto || region || tag || onlyFav) && (
          <Button variant="ghost" size="sm" className="h-6 ml-2" onClick={() => { setProto(null); setRegion(null); setTag(null); setOnlyFav(false) }}>
            <X className="w-3 h-3" /> 清除
          </Button>
        )}
      </div>

      {filtered.length === 0 && !nodes.isLoading ? (
        <EmptyState icon={Server} title="没有匹配的节点" description={q || proto || region || tag || onlyFav ? "试试调整搜索或筛选" : "请联系管理员授权"} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((n) => {
            const isFav = favSet.has(n.id)
            const Icon = PROTOCOL_ICON[n.protocol] || Server
            return (
              <Card key={n.id} className="hover:shadow-md hover:border-primary/40 transition-all group">
                <CardContent className="pt-5 pb-5">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/nodes/${n.id}` as Parameters<typeof Link>[0]["href"]} className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 font-medium truncate">
                        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                        {n.name}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 truncate font-mono">
                        {n.host}:{n.port}
                      </div>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => toggleFav.mutate({ id: n.id, current: isFav })}
                      aria-label={isFav ? "取消收藏" : "收藏"}
                      className={cn("transition-colors", isFav && "text-red-500")}
                    >
                      <Heart className={cn("w-4 h-4", isFav && "fill-current")} />
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant="secondary">{n.protocol.toUpperCase()}</Badge>
                    {n.region && <Badge variant="outline">{n.region}</Badge>}
                    {n.tags && n.tags.split(",").filter(Boolean).map((t) => (
                      <Badge key={t} variant="outline">{t.trim()}</Badge>
                    ))}
                    {n.disabled && <Badge variant="destructive">已禁用</Badge>}
                  </div>
                  {n.description && <div className="mt-3 text-xs text-muted-foreground line-clamp-2">{n.description}</div>}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border transition-colors",
        on ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent"
      )}
    >
      {children}
    </button>
  )
}
