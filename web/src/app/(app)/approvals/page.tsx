"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileCheck,
  Filter,
  Inbox,
  Plus,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { approvalService } from "@/lib/api/services"
import type {
  ApprovalBusinessType,
  ApprovalRequest,
  ApprovalRequestStatus,
  ApprovalRiskLevel,
  ApprovalTask,
} from "@/lib/api/types"
import { fullTime, relTime } from "@/lib/format"

const BIZ_LABELS: Record<ApprovalBusinessType, string> = {
  asset_access: "资产访问",
  credential_use: "凭据使用",
  command_exec: "命令执行",
  sql_exec: "SQL 执行",
  file_transfer: "文件传输",
  session_extend: "会话续期",
  session_elevate: "会话提权",
  break_glass: "应急访问",
  vendor_access: "第三方访问",
  audit_view: "审计查看",
}

const STATUS_LABELS: Record<ApprovalRequestStatus, string> = {
  pending: "待审批",
  approved: "已通过",
  auto_approved: "自动通过",
  rejected: "已驳回",
  cancelled: "已撤销",
  expired: "已过期",
}

const RISK_STYLES: Record<ApprovalRiskLevel, string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  medium: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200",
}

const RISK_LABELS: Record<ApprovalRiskLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
}

function StatusBadge({ status }: { status: ApprovalRequestStatus }) {
  const icon = {
    pending: <Clock className="w-3 h-3" />,
    approved: <CheckCircle2 className="w-3 h-3" />,
    auto_approved: <CheckCircle2 className="w-3 h-3" />,
    rejected: <XCircle className="w-3 h-3" />,
    cancelled: <XCircle className="w-3 h-3" />,
    expired: <Clock className="w-3 h-3" />,
  }[status]
  const variant: Record<ApprovalRequestStatus, "default" | "secondary" | "outline" | "destructive"> = {
    pending: "default",
    approved: "secondary",
    auto_approved: "secondary",
    rejected: "destructive",
    cancelled: "outline",
    expired: "outline",
  }
  return (
    <Badge variant={variant[status]} className="gap-1">
      {icon}
      {STATUS_LABELS[status]}
    </Badge>
  )
}

function RiskPill({ level }: { level: ApprovalRiskLevel }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${RISK_STYLES[level]}`}>
      {(level === "high" || level === "critical") && <ShieldAlert className="w-3 h-3" />}
      风险：{RISK_LABELS[level]}
    </span>
  )
}

export default function ApprovalsPage() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <FileCheck className="w-5 h-5" /> 审批中心
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            高风险动作的统一审批通道 — 资产访问、凭据使用、命令执行、文件传输等 10 类业务都在这里。
          </p>
        </div>
        <CreateRequestButton />
      </div>

      <Tabs defaultValue="tasks" className="w-full">
        <TabsList>
          <TabsTrigger value="tasks" className="gap-1">
            <Inbox className="w-4 h-4" /> 待我审批
          </TabsTrigger>
          <TabsTrigger value="mine" className="gap-1">
            <FileCheck className="w-4 h-4" /> 我的申请
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tasks" className="mt-4">
          <TasksForMeTab />
        </TabsContent>
        <TabsContent value="mine" className="mt-4">
          <MyRequestsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function TasksForMeTab() {
  const q = useQuery({
    queryKey: ["approval.tasks.me"],
    queryFn: () => approvalService.myTasks(100),
    refetchInterval: 15000,
  })
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          需要你处理的审批任务（{q.data?.items.length ?? 0}）
        </div>
        <Button variant="ghost" size="sm" onClick={() => q.refetch()}>
          <RefreshCw className="w-4 h-4" /> 刷新
        </Button>
      </div>
      {q.data?.items.length === 0 && (
        <div className="rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
          没有待你处理的审批 — 收工。
        </div>
      )}
      <div className="grid gap-2">
        {q.data?.items.map((t) => <TaskCard key={t.id} task={t} />)}
      </div>
    </div>
  )
}

function TaskCard({ task }: { task: ApprovalTask }) {
  // The /tasks/me endpoint returns ApprovalTask rows but not the parent
  // request. We pull the parent lazily so the card stays scannable on
  // page load — the user can drill into details by clicking through.
  const req = useQuery({
    queryKey: ["approval.task.parent", task.request_id],
    queryFn: () => approvalService.get(task.request_id),
    staleTime: 30_000,
  })
  const r = req.data?.request
  return (
    <Link
      href={`/approvals/${task.request_id}`}
      className="rounded-lg border p-3 flex items-center justify-between hover:bg-muted/50 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate">
            {r ? r.title || `${BIZ_LABELS[r.business_type]} 申请` : "(加载中)"}
          </span>
          {r && <RiskPill level={r.risk_level} />}
          <Badge variant="outline" className="text-xs">
            阶段 {task.stage + 1}/{r?.total_stages ?? "?"}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {task.stage_mode === "all"
              ? "会签"
              : task.stage_mode === "any"
              ? "或签"
              : `quorum ${task.quorum_n}`}
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground mt-1 truncate">
          {r ? `${r.requester_name} 申请 ${BIZ_LABELS[r.business_type]} — ${r.reason || "（未填写理由）"}` : ""}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          收到于 {relTime(task.created_at)}
          {task.expires_at && ` · 到期 ${relTime(task.expires_at)}`}
        </div>
      </div>
    </Link>
  )
}

function MyRequestsTab() {
  const [status, setStatus] = React.useState<string>("")
  const [biz, setBiz] = React.useState<string>("")
  const q = useQuery({
    queryKey: ["approval.mine", status, biz],
    queryFn: () =>
      approvalService.list({
        mine: true,
        status: status || undefined,
        business_type: biz || undefined,
        limit: 100,
      }),
  })
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={biz || "all"} onValueChange={(v) => setBiz(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="业务类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部业务</SelectItem>
            {Object.entries(BIZ_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="text-xs text-muted-foreground flex items-center gap-1 ml-auto">
          <Filter className="w-3 h-3" /> 共 {q.data?.total ?? 0} 条
        </div>
      </div>
      <div className="grid gap-2">
        {q.data?.items.map((r) => <RequestCard key={r.id} req={r} />)}
        {q.data?.items.length === 0 && (
          <div className="rounded-lg border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
            还没有发起过审批申请。点右上角「发起申请」开始。
          </div>
        )}
      </div>
    </div>
  )
}

function RequestCard({ req }: { req: ApprovalRequest }) {
  return (
    <Link
      href={`/approvals/${req.id}`}
      className="rounded-lg border p-3 flex items-center justify-between hover:bg-muted/50 transition-colors gap-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium truncate">{req.title || `${BIZ_LABELS[req.business_type]} 申请`}</span>
          <RiskPill level={req.risk_level} />
          <Badge variant="outline" className="text-xs">{BIZ_LABELS[req.business_type]}</Badge>
        </div>
        <div className="text-xs text-muted-foreground mt-1 truncate">
          {req.reason || "（未填写理由）"}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {fullTime(req.created_at)} · 窗口 {fullTime(req.window_start)} → {fullTime(req.window_end)}
        </div>
      </div>
      <StatusBadge status={req.status} />
    </Link>
  )
}

function CreateRequestButton() {
  const [open, setOpen] = React.useState(false)
  const qc = useQueryClient()
  const [biz, setBiz] = React.useState<ApprovalBusinessType>("asset_access")
  const [title, setTitle] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [resourceType, setResourceType] = React.useState("node")
  const [resourceID, setResourceID] = React.useState("")
  const [hours, setHours] = React.useState(2)

  const mut = useMutation({
    mutationFn: () =>
      approvalService.create({
        business_type: biz,
        title,
        reason,
        resource_type: resourceType,
        resource_id: resourceID,
        window_end: new Date(Date.now() + hours * 3600_000).toISOString(),
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["approval.mine"] })
      qc.invalidateQueries({ queryKey: ["approval.tasks.me"] })
      if (d.auto_approved) {
        toast.success("已自动批准（policy 命中），grant 已发放")
      } else {
        toast.success("审批申请已创建，等待审批人处理")
      }
      setOpen(false)
      setTitle("")
      setReason("")
      setResourceID("")
    },
    onError: (err: { message?: string }) => {
      toast.error(err.message || "创建失败")
    },
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="w-4 h-4" /> 发起申请
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>发起审批申请</DialogTitle>
          <DialogDescription>
            填写要做什么、对哪个资源做、为什么。审批通过后系统自动发放有限时窗的访问凭证。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">业务类型</Label>
              <Select value={biz} onValueChange={(v) => setBiz(v as ApprovalBusinessType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(BIZ_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">资源类型</Label>
              <Select value={resourceType} onValueChange={setResourceType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="node">节点 (node)</SelectItem>
                  <SelectItem value="credential">凭据 (credential)</SelectItem>
                  <SelectItem value="session">会话 (session)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">资源 ID</Label>
            <Input value={resourceID} onChange={(e) => setResourceID(e.target.value)} placeholder="e.g. 42" />
          </div>
          <div>
            <Label className="text-xs">标题</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说明你要做什么" />
          </div>
          <div>
            <Label className="text-xs">理由</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} placeholder="审批人会看到这段文字 — 解释清楚业务背景与紧迫度" />
          </div>
          <div>
            <Label className="text-xs">需要的访问窗口（小时）</Label>
            <Input
              type="number"
              min={1}
              max={72}
              value={hours}
              onChange={(e) => setHours(Math.max(1, Math.min(72, Number(e.target.value) || 1)))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>取消</Button>
          <Button
            disabled={!biz || !resourceID || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "提交中..." : "提交"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
