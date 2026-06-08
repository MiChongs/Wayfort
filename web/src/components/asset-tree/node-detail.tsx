"use client"

// Shared node detail drawer for the asset tree. The workspace opens it on a
// single click (double-click still connects); the admin trees open it on row
// activate. Shows connection facts, managed tags, live status (with a re-probe
// button), the grant context when viewed from the access tree, and recent
// sessions for admins.

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AppIcon } from "@/components/icons/app-icon"
import { TagBadge } from "@/components/tags/tag-badge"
import { StatusBadge } from "@/components/asset-tree/status-dot"
import { ActionChips, ValidityCell, type GranteeNameFn } from "@/lib/access/grant-display"
import { nodeIcon } from "@/lib/icons/protocol"
import { sessionService } from "@/lib/api/services"
import type { GranteeRef, Node, NodeAccess, NodeStatus } from "@/lib/api/types"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

export function NodeDetailPanel({
  node,
  open,
  onOpenChange,
  status,
  checking,
  onRecheck,
  access,
  granteeName,
  withSessions = false,
}: {
  node: Node | null
  open: boolean
  onOpenChange: (v: boolean) => void
  status?: NodeStatus | null
  checking?: boolean
  onRecheck?: (id: number) => void
  /** Grant context when this panel is opened from the access (按人看) tree. */
  access?: NodeAccess | null
  granteeName?: GranteeNameFn
  /** Admin-only: pull the node's recent sessions. */
  withSessions?: boolean
}) {
  const sessions = useQuery({
    queryKey: ["node-detail", "sessions", node?.id],
    queryFn: () => sessionService.list({ node_id: node!.id, limit: 5 }),
    enabled: !!node && withSessions && open,
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[380px] overflow-y-auto sm:max-w-[420px]">
        {node && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <AppIcon icon={nodeIcon(node)} className="h-5 w-5 shrink-0" />
                <span className="truncate">{node.name}</span>
                {node.disabled && (
                  <Badge variant="outline" className="border-destructive/30 text-destructive">已停用</Badge>
                )}
              </SheetTitle>
              <SheetDescription className="font-mono text-xs">
                {node.host}:{node.port}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-4 px-4 pb-6">
              <section className="rounded-lg border p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">连通状态</span>
                  {onRecheck && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 text-xs"
                      onClick={() => onRecheck(node.id)}
                    >
                      <RefreshCw className="h-3 w-3" /> 重新探测
                    </Button>
                  )}
                </div>
                <StatusBadge status={status} checking={checking} />
              </section>

              <section>
                <Row label="协议">
                  <Badge variant="outline" className="font-normal uppercase">{node.protocol}</Badge>
                </Row>
                <Row label="主机">
                  <span className="font-mono text-xs">{node.host}:{node.port}</span>
                </Row>
                {node.username ? <Row label="用户名">{node.username}</Row> : null}
                {node.credential_name ? <Row label="凭证">{node.credential_name}</Row> : null}
                {node.proxy_names?.length ? <Row label="代理链">{node.proxy_names.join(" → ")}</Row> : null}
                {node.region ? <Row label="区域">{node.region}</Row> : null}
                {node.description ? <Row label="描述">{node.description}</Row> : null}
              </section>

              {node.tag_list?.length ? (
                <section>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">标签</div>
                  <div className="flex flex-wrap gap-1">
                    {node.tag_list.map((t) => (
                      <TagBadge key={t.id} tag={t} />
                    ))}
                  </div>
                </section>
              ) : null}

              {access ? (
                <section className="rounded-lg border border-primary/25 bg-primary/[0.04] p-3">
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">授权</div>
                  <ActionChips actions={access.actions} className="mb-2" />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      来自：
                      {access.sources
                        .map((s: GranteeRef) => (granteeName ? granteeName(s.type, s.id) : `${s.type}#${s.id}`))
                        .join("、")}
                    </span>
                    <ValidityCell to={access.valid_to} />
                  </div>
                </section>
              ) : null}

              {withSessions ? (
                <section>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">最近会话</div>
                  {sessions.isLoading ? (
                    <div className="text-xs text-muted-foreground">加载中…</div>
                  ) : (sessions.data?.sessions.length ?? 0) === 0 ? (
                    <div className="text-xs text-muted-foreground">暂无会话记录</div>
                  ) : (
                    <div className="divide-y rounded-lg border text-xs">
                      {sessions.data!.sessions.map((s) => (
                        <div key={s.id} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                          <span className="truncate">{s.username ?? s.user_id}</span>
                          <span className="shrink-0 text-muted-foreground">
                            {s.started_at ? new Date(s.started_at).toLocaleString() : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              ) : null}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
