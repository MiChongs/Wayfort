"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Heart, Search, Server } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { meService } from "@/lib/api/services"
import { Card, CardContent } from "@/components/ui/card"

export default function NodesPage() {
  const qc = useQueryClient()
  const [q, setQ] = React.useState("")
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const fav = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })

  const toggleFav = useMutation({
    mutationFn: async ({ id, current }: { id: number; current: boolean }) =>
      current ? meService.removeFavorite(id) : meService.addFavorite(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "favorites"] }),
    onError: (e: unknown) => toast.error("操作失败", { description: (e as Error).message }),
  })

  const filtered = (nodes.data?.nodes || []).filter((n) => {
    if (!q) return true
    const s = q.toLowerCase()
    return [n.name, n.host, n.description, n.tags, n.protocol].some((v) => (v || "").toLowerCase().includes(s))
  })
  const favSet = new Set(fav.data?.node_ids || [])

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">节点</h1>
          <p className="text-sm text-muted-foreground mt-1">已授权访问的全部资产</p>
        </div>
        <div className="relative w-64">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 name/host/tag" className="pl-8" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map((n) => {
          const isFav = favSet.has(n.id)
          const proto = n.protocol || "ssh"
          const target = `/nodes/${n.id}` as Parameters<typeof Link>[0]["href"]
          return (
            <Card key={n.id} className="hover:shadow-md transition-shadow">
              <CardContent className="pt-5 pb-5">
                <div className="flex items-start justify-between">
                  <Link href={target} className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Server className="w-4 h-4 text-muted-foreground" />
                      <div className="font-medium truncate">{n.name}</div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      {n.host}:{n.port}
                    </div>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggleFav.mutate({ id: n.id, current: isFav })}
                    aria-label={isFav ? "取消收藏" : "收藏"}
                  >
                    <Heart className={isFav ? "w-4 h-4 fill-red-500 text-red-500" : "w-4 h-4"} />
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{proto.toUpperCase()}</Badge>
                  {n.region && <Badge variant="outline">{n.region}</Badge>}
                  {n.tags && n.tags.split(",").filter(Boolean).map((t) => (
                    <Badge key={t} variant="outline">{t}</Badge>
                  ))}
                  {n.disabled && <Badge variant="destructive">已禁用</Badge>}
                </div>
                {n.description && <div className="mt-3 text-xs text-muted-foreground line-clamp-2">{n.description}</div>}
              </CardContent>
            </Card>
          )
        })}
      </div>
      {filtered.length === 0 && !nodes.isLoading && (
        <div className="text-sm text-muted-foreground text-center py-12">没有匹配的节点</div>
      )}
    </div>
  )
}
