"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Network, Pencil, Plus, Search, Server, Trash2, Zap } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { DomainFormSheet } from "@/components/admin/domain-form-sheet"
import { AgentManagerSheet } from "@/components/admin/agent-manager-sheet"
import { domainService } from "@/lib/api/services"
import type { Domain, DomainKind } from "@/lib/api/types"

const KEY = ["admin", "domains"] as const

const KIND_META: Record<DomainKind, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  direct: { label: "直连", icon: Zap },
  proxy: { label: "代理链", icon: Network },
  agent: { label: "Agent 反连", icon: Bot },
}

export default function DomainsPage() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: KEY, queryFn: domainService.list })
  const [search, setSearch] = React.useState("")
  const [editing, setEditing] = React.useState<Domain | null>(null)

  const invalidate = () => qc.invalidateQueries({ queryKey: KEY })

  const all = q.data?.domains ?? []
  const rows = React.useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return all
    return all.filter(
      (d) =>
        d.name.toLowerCase().includes(s) ||
        (d.description ?? "").toLowerCase().includes(s),
    )
  }, [all, search])

  async function onDelete(d: Domain) {
    if (d.is_default) {
      toast.error("默认网域不可删除")
      return
    }
    const ok = await confirmDialog({
      title: `删除网域「${d.name}」？`,
      description: "若该网域下仍有资产，删除会被拒绝；请先把资产迁移到其他网域。",
      confirmLabel: "删除",
      destructive: true,
    })
    if (!ok) return
    try {
      await domainService.remove(d.id)
      toast.success("网域已删除")
      invalidate()
    } catch (e) {
      toast.error("删除失败", { description: (e as Error).message })
    }
  }

  const columns: Column<Domain>[] = [
    {
      header: "名称",
      cell: (d) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            {d.name}
            {d.is_default && (
              <Badge variant="secondary" className="font-normal">
                默认
              </Badge>
            )}
          </div>
          {d.description && (
            <div className="truncate text-xs text-muted-foreground">{d.description}</div>
          )}
        </div>
      ),
    },
    {
      header: "连通性",
      cell: (d) => {
        const meta = KIND_META[d.kind] ?? KIND_META.direct
        const Icon = meta.icon
        return (
          <span className="inline-flex items-center gap-1.5 text-sm">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            {meta.label}
          </span>
        )
      },
    },
    {
      header: "代理链",
      cell: (d) =>
        d.kind === "proxy" && d.proxy_chain ? (
          <span className="font-mono text-xs text-muted-foreground">{d.proxy_chain}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      header: "允许协议",
      cell: (d) => (
        <span className="text-xs text-muted-foreground">
          {d.allowed_protocols?.trim() ? d.allowed_protocols : "全部"}
        </span>
      ),
    },
    {
      header: "并发上限",
      cell: (d) => (
        <span className="text-sm text-muted-foreground">
          {d.max_concurrent_sessions && d.max_concurrent_sessions > 0
            ? d.max_concurrent_sessions
            : "不限"}
        </span>
      ),
    },
    {
      header: "操作",
      className: "text-right",
      cell: (d) => (
        <div className="flex items-center justify-end gap-0.5">
          {d.kind === "agent" && (
            <AgentManagerSheet
              domain={d}
              trigger={
                <Button size="sm" variant="outline" aria-label="管理 Agent">
                  <Bot className="h-4 w-4" />
                  Agent
                </Button>
              }
            />
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setEditing(d)}
            aria-label="编辑"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => onDelete(d)}
            disabled={d.is_default}
            aria-label="删除"
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  const showEmpty = !q.isLoading && all.length === 0

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Server className="h-5 w-5" />
            </span>
            网域
          </h1>
        </div>
        <DomainFormSheet
          trigger={
            <Button>
              <Plus className="h-4 w-4" />
              新增网域
            </Button>
          }
          onSaved={invalidate}
        />
      </div>

      {!showEmpty && (
        <>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索网域名称 / 描述…"
              className="pl-9"
            />
          </div>
          <DataTable columns={columns} rows={rows} loading={q.isLoading} virtualize />
        </>
      )}

      {showEmpty && (
        <EmptyState
          icon={Server}
          title="还没有任何网域"
          description="系统已内置「default」直连域；现有资产都已归入其中。新建代理域或 Agent 域以接入隔离网络。"
          action={
            <DomainFormSheet
              trigger={
                <Button>
                  <Plus className="h-4 w-4" />
                  新增网域
                </Button>
              }
              onSaved={invalidate}
            />
          }
        />
      )}

      {editing && (
        <DomainFormSheet
          mode="edit"
          domain={editing}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          onSaved={() => {
            invalidate()
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
