"use client"

// Phase 10 — admin proxies page. AddProxySheet replaces the legacy Dialog;
// a per-kind summary header surfaces inventory at a glance, the kind column
// uses a tinted Badge consistent with the chain builder.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleSlash, Network, Server } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/common/data-table"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { AddProxySheet } from "@/components/admin/add-proxy-sheet"
import { credentialService, proxyService } from "@/lib/api/services"
import type { Proxy, ProxyKind } from "@/lib/api/types"

const KIND_LABEL: Record<ProxyKind, string> = {
  direct: "Direct",
  socks5: "SOCKS5",
  bastion: "SSH 跳板",
  http_connect: "HTTP CONNECT",
}

const KIND_TONE: Record<ProxyKind, string> = {
  direct: "bg-muted text-muted-foreground border-border",
  socks5: "bg-sky-500/10 text-sky-600 dark:text-sky-300 border-sky-500/30",
  bastion: "bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/30",
  http_connect: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
}

export default function ProxiesPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })
  const creds = useQuery({ queryKey: ["admin", "credentials"], queryFn: credentialService.list })
  const remove = useMutation({
    mutationFn: (id: number) => proxyService.remove(id),
    onSuccess: () => {
      toast.success("代理已删除")
      qc.invalidateQueries({ queryKey: ["admin", "proxies"] })
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  const cols: Column<Proxy>[] = [
    {
      header: "名称",
      cell: (p) => (
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="font-medium">{p.name}</span>
            {p.disabled && (
              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-300">
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
    { header: "地址", cell: (p) => (p.host ? <span className="font-mono">{p.host}:{p.port}</span> : "—") },
    {
      header: "凭据",
      cell: (p) =>
        p.credential_id
          ? (creds.data?.credentials || []).find((c) => c.id === p.credential_id)?.name || `#${p.credential_id}`
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

  const summary = list.data?.summary
  const total = summary?.total ?? list.data?.proxies?.length ?? 0

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Network className="h-5 w-5" /> 代理 / 跳板
          </h1>
          <p className="text-sm text-muted-foreground">维护可用代理 hop;在节点详情中组合成链路。</p>
        </div>
        <AddProxySheet
          credentials={creds.data?.credentials || []}
          onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "proxies"] })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <SummaryCard label="总数" value={total} icon={Server} />
        <SummaryCard label="Direct" value={summary?.by_kind?.direct ?? 0} tone="direct" />
        <SummaryCard label="SOCKS5" value={summary?.by_kind?.socks5 ?? 0} tone="socks5" />
        <SummaryCard label="跳板" value={summary?.by_kind?.bastion ?? 0} tone="bastion" />
        <SummaryCard label="HTTP" value={summary?.by_kind?.http_connect ?? 0} tone="http_connect" />
      </div>

      <DataTable columns={cols} rows={list.data?.proxies} loading={list.isLoading} virtualize />
      {(list.data?.proxies?.length ?? 0) === 0 && !list.isLoading && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <CircleSlash className="h-6 w-6" />
            尚未配置任何代理。点击右上 “新建代理” 添加首个 hop。
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: number
  icon?: React.ComponentType<{ className?: string }>
  tone?: ProxyKind
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums">{value}</p>
        </div>
        {tone ? (
          <Badge variant="outline" className={cn("font-normal", KIND_TONE[tone])}>
            {KIND_LABEL[tone]}
          </Badge>
        ) : Icon ? (
          <Icon className="h-5 w-5 text-muted-foreground" />
        ) : null}
      </CardContent>
    </Card>
  )
}
