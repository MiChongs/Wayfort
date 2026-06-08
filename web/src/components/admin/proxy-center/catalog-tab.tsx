"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/common/data-table"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { AddProxySheet } from "@/components/admin/add-proxy-sheet"
import { proxyService } from "@/lib/api/services"
import type { Credential, Proxy } from "@/lib/api/types"
import { KIND_LABEL, KIND_TONE } from "../proxy-kind"
import { HealthDot } from "../proxy-health/health-dot"
import { LatencyBadge } from "../proxy-health/latency-badge"
import { useProxyHealthCtx } from "../proxy-health/health-context"

export function CatalogTab({
  proxies,
  credentials,
  summary,
  loading,
}: {
  proxies: Proxy[]
  credentials: Credential[]
  summary?: { total: number; by_kind: Record<string, number> }
  loading?: boolean
}) {
  const qc = useQueryClient()
  const health = useProxyHealthCtx()
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "proxies"] })

  const remove = useMutation({
    mutationFn: (id: number) => proxyService.remove(id),
    onSuccess: () => {
      toast.success("代理已删除")
      invalidate()
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  const cols: Column<Proxy>[] = [
    {
      header: "状态",
      cell: (p) => {
        const h = health.byId(p.id)
        return (
          <span className="flex items-center gap-1.5">
            <HealthDot state={h?.state ?? "unknown"} title={h?.last_error || undefined} />
            <LatencyBadge ms={h?.latency_ms} />
          </span>
        )
      },
    },
    {
      header: "名称",
      cell: (p) => (
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium">{p.name}</span>
            {p.disabled && (
              <Badge variant="outline" className="border-warning/30 bg-warning/10 font-normal text-warning">
                已禁用
              </Badge>
            )}
          </div>
          {p.description && <p className="truncate text-xs text-muted-foreground">{p.description}</p>}
        </div>
      ),
    },
    {
      header: "类型",
      cell: (p) => (
        <Badge variant="outline" className={cn("font-normal", KIND_TONE[p.kind])}>
          {KIND_LABEL[p.kind]}
        </Badge>
      ),
    },
    {
      header: "地址",
      cell: (p) =>
        p.kind === "failover" ? (
          <span className="text-muted-foreground">{p.group?.members.length ?? 0} 个成员</span>
        ) : p.host ? (
          <span className="font-mono">{p.host}:{p.port}</span>
        ) : (
          "—"
        ),
    },
    {
      header: "凭据",
      cell: (p) =>
        p.credential_id
          ? credentials.find((c) => c.id === p.credential_id)?.name || `#${p.credential_id}`
          : "—",
    },
    {
      header: "操作",
      className: "text-right",
      cell: (p) => (
        <ConfirmDeleteIconButton
          title={`删除代理 “${p.name}”？`}
          description="正在使用此代理的链路会立刻失效;若仍有节点引用,请先在节点详情里调整代理链。"
          loading={remove.isPending}
          onConfirm={() => remove.mutate(p.id)}
        />
      ),
    },
  ]

  const KINDS: { key: string; label: string }[] = [
    { key: "socks5", label: "SOCKS5" },
    { key: "socks4", label: "SOCKS4" },
    { key: "bastion", label: "SSH 跳板" },
    { key: "http_connect", label: "HTTP" },
    { key: "failover", label: "故障转移" },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <AddProxySheet credentials={credentials} proxies={proxies} onCreated={invalidate} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryCard label="总数" value={summary?.total ?? proxies.length} />
        {KINDS.map((k) => (
          <SummaryCard key={k.key} label={k.label} value={summary?.by_kind?.[k.key] ?? 0} />
        ))}
      </div>

      <DataTable columns={cols} rows={proxies} loading={loading} virtualize />
      {proxies.length === 0 && !loading && (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            尚未配置任何代理。点击右上 “新建代理” 添加首个 hop。
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  )
}
