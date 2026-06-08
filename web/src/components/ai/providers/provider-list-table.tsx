"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Pencil, RefreshCw, TestTube2, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/common/data-table"
import { AppIcon } from "@/components/icons/app-icon"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { aiProviderService, type ProviderHealthSnapshot } from "@/lib/api/services"
import { presetIconFor } from "./preset-icons"
import { HealthDot } from "./health-dot"
import type { AIProvider } from "@/lib/api/types"

const KIND_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openai_compatible: "OpenAI 兼容",
  gemini: "Gemini",
}

// ProviderListTable renders the configured providers with a LIVE health column.
// Exactly one SSE subscription is mounted here (table level) and indexed by id —
// never per row.
export function ProviderListTable({
  providers,
  loading,
  onSelect,
}: {
  providers?: AIProvider[]
  loading: boolean
  onSelect: (p: AIProvider) => void
}) {
  const qc = useQueryClient()
  const healthURL = React.useMemo(() => aiProviderService.healthStreamURL(), [])
  const { data: snap, status } = useSseSnapshot<ProviderHealthSnapshot>(healthURL)

  const remove = useMutation({
    mutationFn: (id: number) => aiProviderService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "providers"] })
      toast.success("已删除")
    },
  })
  const test = useMutation({
    mutationFn: (id: number) => aiProviderService.test(id),
    onSuccess: (r) =>
      r.ok
        ? toast.success("拨测成功", { description: r.latency_ms ? `延迟 ${r.latency_ms}ms` : undefined })
        : toast.error("拨测失败", { description: r.error }),
    onError: (e: unknown) => toast.error("拨测失败", { description: (e as Error).message }),
  })

  const cols: Column<AIProvider>[] = [
    {
      header: "名称",
      cell: (p) => (
        <button className="flex min-w-0 items-center gap-2 text-left hover:underline" onClick={() => onSelect(p)}>
          <AppIcon icon={presetIconFor(p)} size={20} fallback="lucide:sparkles" className="shrink-0" />
          <span className="truncate font-medium">{p.display_name || p.name}</span>
        </button>
      ),
    },
    { header: "类型", cell: (p) => <Badge variant="outline">{KIND_LABEL[p.kind] ?? p.kind}</Badge> },
    {
      header: "健康",
      cell: (p) => <HealthDot health={snap?.providers?.[p.id] ?? p.health} status={status} />,
    },
    { header: "范围", cell: (p) => (p.is_global ? <Badge variant="success">全局</Badge> : <Badge variant="outline">个人</Badge>) },
    { header: "默认模型", cell: (p) => <span className="font-mono text-xs">{p.default_model || "—"}</span> },
    { header: "Key", cell: (p) => <span className="font-mono text-xs text-muted-foreground">…{p.api_key_last4 || "????"}</span> },
    {
      header: "模型",
      cell: (p) => {
        const n = snap?.providers?.[p.id]?.model_count ?? p.models?.length
        return <span className="tabular-nums text-muted-foreground">{n ?? "—"}</span>
      },
      className: "text-right",
    },
    { header: "状态", cell: (p) => (p.enabled ? <Badge variant="success">启用</Badge> : <Badge variant="outline">停用</Badge>) },
    {
      header: "操作",
      className: "text-right",
      cell: (p) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" title="拨测" onClick={() => test.mutate(p.id)}>
            <TestTube2 className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="管理 / 模型" onClick={() => onSelect(p)}>
            <RefreshCw className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" title="编辑" onClick={() => onSelect(p)}>
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="删除"
            onClick={async () => {
              const ok = await confirmDialog({ title: `删除 ${p.name}？`, destructive: true })
              if (ok) remove.mutate(p.id)
            }}
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <DataTable
      columns={cols}
      rows={providers}
      loading={loading}
      empty="还没有配置任何 AI 提供商"
      rowKey={(p) => p.id}
      virtualize
    />
  )
}
