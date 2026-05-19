"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Copy, Heart, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { meService, nodeService } from "@/lib/api/services"
import type { Node } from "@/lib/api/types"
import { metaOf, protocolChoicesForNode, type ProtocolChoice } from "../protocolMeta"
import { useWorkspaceStore } from "../useWorkspaceStore"

type Props = {
  nodeId: number
}

// NodeInfoTab — node metadata + quick-launch buttons for every protocol the
// node supports. Replaces the "go to node detail page" jump-out so the user
// stays inside the workspace.
export function NodeInfoTab({ nodeId }: Props) {
  const node = useQuery({
    queryKey: ["node", nodeId],
    queryFn: () => nodeService.get(nodeId),
  })
  const favorites = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })
  const open = useWorkspaceStore((s) => s.open)

  const isFav = (favorites.data?.node_ids ?? []).includes(nodeId)

  const openWith = (n: Node, choice: ProtocolChoice) =>
    open({
      nodeId: n.id,
      protocol: choice.protocol,
      rdpBackend: choice.rdpBackend,
      title: n.name,
      host: n.host,
      port: n.port,
    })

  const copy = (val: string) => {
    void navigator.clipboard?.writeText(val)
    toast.success("已复制", { description: val })
  }

  if (node.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="w-4 h-4 animate-spin" /> 加载节点信息…
      </div>
    )
  }
  if (!node.data) {
    return <div className="p-6 text-sm text-destructive">未找到节点</div>
  }

  const n = node.data
  const choices = protocolChoicesForNode(n.protocol)
  const tags = (n.tags || "").split(",").map((s) => s.trim()).filter(Boolean)
  const hostPort = `${n.host}:${n.port}`

  return (
    <div className="p-4 space-y-4 text-sm overflow-y-auto h-full">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold truncate" title={n.name}>{n.name}</h2>
            {isFav && <Heart className="w-3.5 h-3.5 fill-amber-400 text-amber-400 shrink-0" />}
            {n.disabled && <Badge variant="destructive">已禁用</Badge>}
          </div>
          <div className="font-mono text-xs text-muted-foreground inline-flex items-center gap-1">
            {hostPort}
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => copy(hostPort)}
              title="复制"
            >
              <Copy className="w-3 h-3" />
            </button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => void node.refetch()}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${node.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Quick-launch */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          快捷动作
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {choices.map((choice) => {
            const meta = metaOf(choice.protocol)
            const Icon = meta.icon
            return (
              <Button
                key={choice.value}
                variant="outline"
                size="sm"
                className="justify-start h-9"
                onClick={() => openWith(n, choice)}
                title={choice.description}
              >
                <Icon className={`w-4 h-4 ${meta.tint}`} />
                <span className="truncate">{choice.label}</span>
              </Button>
            )
          })}
        </div>
      </section>

      {/* Metadata */}
      <section>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          节点详情
        </h3>
        <div className="grid grid-cols-[6rem_1fr] gap-y-1.5 gap-x-3 text-xs">
          <FieldLabel>协议</FieldLabel>
          <span className="uppercase">{n.protocol}</span>

          <FieldLabel>用户名</FieldLabel>
          <span className="font-mono">{n.username || "—"}</span>

          {n.region && (
            <>
              <FieldLabel>区域</FieldLabel>
              <span>{n.region}</span>
            </>
          )}

          {tags.length > 0 && (
            <>
              <FieldLabel>标签</FieldLabel>
              <div className="flex gap-1 flex-wrap">
                {tags.map((t) => (
                  <Badge key={t} variant="secondary" className="text-[10px]">
                    {t}
                  </Badge>
                ))}
              </div>
            </>
          )}

          <FieldLabel>凭据 ID</FieldLabel>
          <span className="font-mono">{n.credential_id || "—"}</span>

          {n.proxy_chain && (
            <>
              <FieldLabel>代理链</FieldLabel>
              <span className="font-mono">{n.proxy_chain}</span>
            </>
          )}

          {n.description && (
            <>
              <FieldLabel>描述</FieldLabel>
              <span className="whitespace-pre-wrap">{n.description}</span>
            </>
          )}
        </div>
      </section>

      {n.proto_options && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            协议参数
          </h3>
          <pre className="bg-muted rounded-md p-2 text-[11px] font-mono whitespace-pre overflow-x-auto max-h-40">
            {prettyJSON(n.proto_options)}
          </pre>
        </section>
      )}
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground">{children}</div>
}

function prettyJSON(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}
