"use client"

// Phase 10 — admin nodes page reshaped around the new AddNodeSheet (Sheet,
// not Dialog) and the visual ProxyChainSummary column. Native confirm() is
// replaced with the shadcn AlertDialog wrapper.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Server } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { DataTable, type Column } from "@/components/common/data-table"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { AddNodeSheet } from "@/components/admin/add-node-sheet"
import { ProxyChainSummary } from "@/components/admin/proxy-chain-builder"
import { credentialService, nodeService, proxyService } from "@/lib/api/services"
import type { Node } from "@/lib/api/types"

export default function AdminNodesPage() {
  const qc = useQueryClient()
  const nodes = useQuery({ queryKey: ["admin", "nodes"], queryFn: nodeService.list })
  const creds = useQuery({ queryKey: ["admin", "credentials"], queryFn: credentialService.list })
  const proxies = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })

  const remove = useMutation({
    mutationFn: (id: number) => nodeService.remove(id),
    onSuccess: () => {
      toast.success("节点已删除")
      qc.invalidateQueries({ queryKey: ["admin", "nodes"] })
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  const columns: Column<Node>[] = [
    { header: "名称", cell: (n) => <span className="font-medium">{n.name}</span> },
    { header: "协议", cell: (n) => <Badge variant="secondary">{n.protocol}</Badge> },
    { header: "地址", cell: (n) => `${n.host}:${n.port}` },
    { header: "用户", cell: (n) => n.username || "—" },
    {
      header: "代理链",
      cell: (n) => (
        <ProxyChainSummary chain={n.proxy_chain || ""} proxies={proxies.data?.proxies || []} />
      ),
    },
    {
      header: "操作",
      className: "text-right",
      cell: (n) => (
        <ConfirmDeleteIconButton
          title={`删除节点 “${n.name}”？`}
          description={
            <span>
              将清除资产 <span className="font-mono">{n.host}:{n.port}</span> 的元数据,会话历史保留。
            </span>
          }
          loading={remove.isPending}
          onConfirm={() => remove.mutate(n.id)}
        />
      ),
    },
  ]

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Server className="h-5 w-5" /> 节点 — 资产
          </h1>
          <p className="text-sm text-muted-foreground">管理可登录的远端节点及其代理链。</p>
        </div>
        <AddNodeSheet
          credentials={creds.data?.credentials || []}
          proxies={proxies.data?.proxies || []}
          onCreated={() => qc.invalidateQueries({ queryKey: ["admin", "nodes"] })}
        />
      </div>
      <DataTable columns={columns} rows={nodes.data?.nodes} loading={nodes.isLoading} />
    </div>
  )
}
