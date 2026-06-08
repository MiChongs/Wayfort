"use client"

// Right-panel inspector for a selected node in the asset console: connection
// facts (read-only) with an 编辑 button that opens the full NodeFormSheet drawer,
// an 授权 tab (who-can-access + assign via GrantWizard), and recent sessions.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2, Activity, ShieldPlus } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppIcon } from "@/components/icons/app-icon"
import { TagBadge } from "@/components/tags/tag-badge"
import { GrantWizard, useGrantDirectories } from "@/components/admin/grant-wizard"
import { confirmDialog } from "@/components/common/confirm-dialog"
import {
  ActionChips,
  ValidityCell,
  GRANTEE_KIND_LABEL,
  VIA_LABEL,
  granteeNameFrom,
} from "@/lib/access/grant-display"
import { nodeIcon } from "@/lib/icons/protocol"
import { grantService, nodeService, sessionService } from "@/lib/api/services"
import type { Node } from "@/lib/api/types"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

export function NodeInspector({
  node,
  onEdit,
  onDeleted,
  onChanged,
}: {
  node: Node
  onEdit: (n: Node) => void
  onDeleted?: () => void
  onChanged?: () => void
}) {
  const qc = useQueryClient()
  const { granteeCats } = useGrantDirectories()
  const granteeName = React.useMemo(
    () =>
      granteeNameFrom((t, id) => granteeCats.find((c) => c.key === t)?.items.find((i) => i.id === id)?.name),
    [granteeCats],
  )

  const who = useQuery({
    queryKey: ["access", "by-subject", node.id],
    queryFn: () => grantService.bySubject(node.id),
  })
  const sessions = useQuery({
    queryKey: ["node-detail", "sessions", node.id],
    queryFn: () => sessionService.list({ node_id: node.id, limit: 8 }),
  })

  const test = useMutation({
    mutationFn: () => nodeService.test(node.id),
    onSuccess: (r) =>
      r.ok
        ? toast.success(`连通成功 · ${node.name}`, { description: `${r.mode?.toUpperCase()} · ${r.latency_ms}ms` })
        : toast.error(`连通失败 · ${node.name}`, { description: r.error }),
    onError: (e: Error) => toast.error("测试失败", { description: e.message }),
  })
  const revoke = useMutation({
    mutationFn: (id: number) => grantService.remove(id),
    onSuccess: () => {
      toast.success("已撤销")
      qc.invalidateQueries({ queryKey: ["access", "by-subject", node.id] })
      onChanged?.()
    },
  })
  const remove = useMutation({
    mutationFn: () => nodeService.remove(node.id),
    onSuccess: () => {
      toast.success("已删除节点")
      onDeleted?.()
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <AppIcon icon={nodeIcon(node)} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{node.name}</h2>
            {node.disabled && <Badge variant="outline" className="border-destructive/30 text-destructive">已停用</Badge>}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{node.host}:{node.port}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" className="gap-1" disabled={test.isPending} onClick={() => test.mutate()}>
            <Activity className="h-3.5 w-3.5" /> 测试
          </Button>
          <Button variant="outline" size="sm" className="gap-1" onClick={() => onEdit(node)}>
            <Pencil className="h-3.5 w-3.5" /> 编辑
          </Button>
        </div>
      </div>

      <Tabs defaultValue="detail" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-5 mt-3 w-fit">
          <TabsTrigger value="detail">详情</TabsTrigger>
          <TabsTrigger value="grants">授权 {who.data ? `· ${who.data.grantees.length}` : ""}</TabsTrigger>
          <TabsTrigger value="sessions">会话</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          <TabsContent value="detail" className="mt-0">
            <section>
              <Row label="协议"><Badge variant="outline" className="font-normal uppercase">{node.protocol}</Badge></Row>
              <Row label="地址"><span className="font-mono text-xs">{node.host}:{node.port}</span></Row>
              {node.username ? <Row label="用户名">{node.username}</Row> : null}
              {node.credential_name ? <Row label="凭据">{node.credential_name}</Row> : null}
              {node.proxy_names?.length ? <Row label="代理链">{node.proxy_names.join(" → ")}</Row> : <Row label="代理链"><span className="text-muted-foreground">直连</span></Row>}
              {node.region ? <Row label="区域">{node.region}</Row> : null}
              {node.description ? <Row label="描述">{node.description}</Row> : null}
            </section>
            {node.tag_list?.length ? (
              <section className="mt-3">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">标签</div>
                <div className="flex flex-wrap gap-1">{node.tag_list.map((t) => <TagBadge key={t.id} tag={t} />)}</div>
              </section>
            ) : null}
            <div className="mt-4 border-t pt-3">
              <Button
                variant="outline"
                size="sm"
                className="gap-1 text-destructive hover:text-destructive"
                onClick={async () => {
                  if (await confirmDialog({ title: `删除节点「${node.name}」？`, description: "授权与会话历史保留，但用户将无法再连接它。", destructive: true })) remove.mutate()
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> 删除节点
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="grants" className="mt-0 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">谁能访问这台资产</span>
              <GrantWizard
                fixedSubject={{ type: "node", id: node.id, name: node.name }}
                onDone={() => qc.invalidateQueries({ queryKey: ["access", "by-subject", node.id] })}
                trigger={<Button size="sm" className="gap-1"><ShieldPlus className="h-3.5 w-3.5" /> 分配给用户</Button>}
              />
            </div>
            {who.isLoading ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : (who.data?.grantees.length ?? 0) === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">还没有人能访问。点「分配给用户」开始。</div>
            ) : (
              <div className="divide-y rounded-lg border">
                {who.data!.grantees.map((row) => (
                  <div key={row.grant_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <Badge variant="outline" className="font-normal">{GRANTEE_KIND_LABEL[row.grantee_type]}</Badge>
                    <span className="font-medium">{granteeName(row.grantee_type, row.grantee_id)}</span>
                    <ActionChips actions={row.actions} />
                    <Badge variant="secondary" className="font-normal">经由 {VIA_LABEL[row.via]}</Badge>
                    <div className="ml-auto flex items-center gap-2">
                      <ValidityCell to={row.valid_to} />
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        onClick={async () => {
                          if (await confirmDialog({ title: "撤销这条授权？", destructive: true })) revoke.mutate(row.grant_id)
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="sessions" className="mt-0">
            {sessions.isLoading ? (
              <div className="text-sm text-muted-foreground">加载中…</div>
            ) : (sessions.data?.sessions.length ?? 0) === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">暂无会话记录</div>
            ) : (
              <div className="divide-y rounded-lg border text-sm">
                {sessions.data!.sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="truncate">{s.username}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {s.started_at ? new Date(s.started_at).toLocaleString() : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
