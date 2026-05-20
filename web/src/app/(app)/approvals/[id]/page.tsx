"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  Hash,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  UserCheck,
  UserX,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import { approvalService } from "@/lib/api/services"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { fullTime, relTime } from "@/lib/format"
import type { ApprovalTask } from "@/lib/api/types"

export default function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const me = useCurrentUser()

  const detail = useQuery({
    queryKey: ["approval.detail", id],
    queryFn: () => approvalService.get(id),
    refetchInterval: 8000,
  })

  const verify = useMutation({
    mutationFn: () => approvalService.verifyChain(id),
    onSuccess: (r) => {
      if (r.ok) toast.success(`审计链校验通过 (${r.total_events} 条事件)`)
      else toast.error(`审计链断裂！事件 #${r.first_bad_event_id} — ${r.reason}`)
    },
  })

  const cancelMut = useMutation({
    mutationFn: (reason: string) => approvalService.cancel(id, reason),
    onSuccess: () => {
      toast.success("已撤销")
      qc.invalidateQueries({ queryKey: ["approval.detail", id] })
    },
    onError: (e: { message?: string }) => toast.error(e.message || "撤销失败"),
  })

  if (detail.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">加载中...</div>
  }
  if (!detail.data) {
    return (
      <div className="p-6">
        <Link href="/approvals" className="text-sm text-primary hover:underline">
          <ArrowLeft className="w-3 h-3 inline" /> 返回列表
        </Link>
        <div className="mt-4 rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          审批请求不存在或你无权查看。
        </div>
      </div>
    )
  }

  const { request: r, tasks, events, grant } = detail.data
  const myTasks = tasks.filter((t) => t.approver_id === me?.uid && t.state === "pending")
  const canCancel = me?.uid === r.requester_id && r.status === "pending"

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      <div className="flex items-center gap-2 text-sm">
        <Link href="/approvals" className="text-primary hover:underline">
          <ArrowLeft className="w-3 h-3 inline" /> 返回审批中心
        </Link>
      </div>

      <div className="rounded-lg border p-4 space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold truncate">{r.title || `${r.business_type} 申请`}</h1>
            <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
              <span>{r.requester_name}</span>
              <span>·</span>
              <span>创建于 {fullTime(r.created_at)}</span>
              {r.resolved_at && (
                <>
                  <span>·</span>
                  <span>处理于 {fullTime(r.resolved_at)}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline">{r.business_type}</Badge>
            <Badge>{r.status}</Badge>
            <Badge variant="secondary">风险：{r.risk_level}</Badge>
          </div>
        </div>

        <Separator />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">资源</div>
            <div className="font-mono">{r.resource_type || "-"}:{r.resource_id || "-"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">阶段进度</div>
            <div>{r.current_stage < 0 ? "已结束" : `${r.current_stage + 1} / ${r.total_stages}`}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">访问窗口</div>
            <div className="text-xs">
              {fullTime(r.window_start)} → {fullTime(r.window_end)}
              {r.effective_window_end && r.effective_window_end !== r.window_end && (
                <span className="text-amber-600 ml-1">（实际到 {fullTime(r.effective_window_end)}）</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">客户端 IP</div>
            <div className="font-mono text-xs">{r.client_ip || "-"}</div>
          </div>
        </div>

        {r.reason && (
          <>
            <Separator />
            <div>
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <FileText className="w-3 h-3" /> 理由
              </div>
              <div className="text-sm whitespace-pre-wrap">{r.reason}</div>
            </div>
          </>
        )}

        {canCancel && (
          <div className="pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const reason = prompt("撤销原因：")
                if (reason !== null) cancelMut.mutate(reason)
              }}
            >
              撤销申请
            </Button>
          </div>
        )}
      </div>

      {grant && (
        <div className="rounded-lg border p-4 bg-emerald-50 dark:bg-emerald-900/20 space-y-2">
          <div className="flex items-center gap-2 font-medium">
            <KeyRound className="w-4 h-4" />
            已发放 Grant
            <Badge variant="outline" className="ml-auto">{grant.status}</Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Grant ID</div>
              <div className="font-mono text-xs">{grant.id}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Actions</div>
              <div className="font-mono text-xs">{grant.actions}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">有效至</div>
              <div className="text-xs">{fullTime(grant.not_after)} ({relTime(grant.not_after)})</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">已使用</div>
              <div className="text-xs">{grant.used_count} {grant.max_uses > 0 && ` / ${grant.max_uses}`}</div>
            </div>
          </div>
        </div>
      )}

      {myTasks.length > 0 && (
        <div className="rounded-lg border p-4 space-y-3 bg-primary/5">
          <div className="font-medium flex items-center gap-2">
            <UserCheck className="w-4 h-4" /> 等待你处理（{myTasks.length}）
          </div>
          {myTasks.map((t) => <DecideForm key={t.id} task={t} onDone={() => detail.refetch()} />)}
        </div>
      )}

      <Tabs defaultValue="tasks">
        <TabsList>
          <TabsTrigger value="tasks">审批流（{tasks.length}）</TabsTrigger>
          <TabsTrigger value="events">审计账本（{events.length}）</TabsTrigger>
        </TabsList>
        <TabsContent value="tasks" className="mt-3 space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="rounded-lg border p-3 flex items-center justify-between text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline">阶段 {t.stage + 1}</Badge>
                <Badge variant="outline">{t.stage_mode}</Badge>
                <span>审批人：<code className="text-xs">#{t.approver_id}</code></span>
                {t.approver_role && <span className="text-xs text-muted-foreground">(角色 {t.approver_role})</span>}
              </div>
              <div className="flex items-center gap-2">
                <TaskStateIcon state={t.state} />
                <span className="text-xs">
                  {t.decided_at ? relTime(t.decided_at) : t.expires_at ? `到期 ${relTime(t.expires_at)}` : ""}
                </span>
              </div>
              {t.comment && (
                <div className="w-full text-xs text-muted-foreground mt-1 pl-1">{t.comment}</div>
              )}
            </div>
          ))}
        </TabsContent>
        <TabsContent value="events" className="mt-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              SHA-256 哈希链 — 每条事件 PrevHash 指向上一条 Hash，篡改单条会让后续整条链失效。
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => verify.mutate()}
              disabled={verify.isPending}
            >
              <ShieldCheck className="w-4 h-4" />
              {verify.isPending ? "校验中..." : "校验链完整性"}
            </Button>
          </div>
          {events.map((e) => (
            <div key={e.id} className="rounded-lg border p-2 text-xs font-mono space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px]">#{e.id}</Badge>
                <span className="font-semibold">{e.kind}</span>
                <span className="text-muted-foreground">{relTime(e.created_at)}</span>
                {e.actor_name && <span>by {e.actor_name}</span>}
                {e.signature && (
                  <Badge variant="secondary" className="text-[10px] gap-1">
                    <Hash className="w-3 h-3" /> KMS 签名
                  </Badge>
                )}
              </div>
              {e.payload && (
                <div className="text-muted-foreground text-[11px] truncate">{e.payload}</div>
              )}
            </div>
          ))}
          {events.length === 0 && (
            <div className="text-xs text-muted-foreground py-4 text-center">尚无事件</div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function TaskStateIcon({ state }: { state: string }) {
  switch (state) {
    case "approved":
      return <Badge variant="secondary" className="gap-1"><CheckCircle2 className="w-3 h-3" /> 通过</Badge>
    case "rejected":
      return <Badge variant="destructive" className="gap-1"><XCircle className="w-3 h-3" /> 驳回</Badge>
    case "delegated":
      return <Badge variant="outline" className="gap-1"><UserX className="w-3 h-3" /> 已委托</Badge>
    case "expired":
      return <Badge variant="outline" className="gap-1"><Clock className="w-3 h-3" /> 已过期</Badge>
    case "skipped":
      return <Badge variant="outline" className="gap-1"><ShieldOff className="w-3 h-3" /> 跳过</Badge>
    case "pending":
      return <Badge variant="default" className="gap-1"><Clock className="w-3 h-3" /> 待处理</Badge>
  }
  return <Badge variant="outline">{state}</Badge>
}

function DecideForm({ task, onDone }: { task: ApprovalTask; onDone: () => void }) {
  const [comment, setComment] = React.useState("")
  const approveMut = useMutation({
    mutationFn: () => approvalService.approve(task.id, comment),
    onSuccess: () => { toast.success("已批准"); onDone() },
    onError: (e: { message?: string }) => toast.error(e.message || "批准失败"),
  })
  const rejectMut = useMutation({
    mutationFn: () => approvalService.reject(task.id, comment),
    onSuccess: () => { toast.success("已驳回"); onDone() },
    onError: (e: { message?: string }) => toast.error(e.message || "驳回失败"),
  })

  return (
    <div className="space-y-2 bg-background rounded-md p-3 border">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">阶段 {task.stage + 1}</Badge>
        <span className="text-xs text-muted-foreground">收到 {relTime(task.created_at)}</span>
        {task.expires_at && (
          <span className="text-xs text-amber-600 ml-auto">
            <Clock className="w-3 h-3 inline" /> 到期 {relTime(task.expires_at)}
          </span>
        )}
      </div>
      <div>
        <Label className="text-xs">审批意见</Label>
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder="（可选）说明决策理由 — 写明上下文，方便日后审计"
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button
          variant="destructive"
          size="sm"
          disabled={rejectMut.isPending}
          onClick={() => rejectMut.mutate()}
        >
          <XCircle className="w-4 h-4" /> 驳回
        </Button>
        <Button
          size="sm"
          disabled={approveMut.isPending}
          onClick={() => approveMut.mutate()}
        >
          <CheckCircle2 className="w-4 h-4" /> 批准
        </Button>
      </div>
    </div>
  )
}
