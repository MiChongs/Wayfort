"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, Plus, Send } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { approvalService } from "@/lib/api/services"
import type { ApprovalBusinessType } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { BIZ_HINTS, BIZ_ICONS, BIZ_LABELS } from "@/lib/approvals/meta"
import { DurationField } from "./duration-field"

const BIZ_ORDER: ApprovalBusinessType[] = [
  "asset_access",
  "credential_use",
  "command_exec",
  "sql_exec",
  "file_transfer",
  "session_extend",
  "session_elevate",
  "vendor_access",
  "audit_view",
  "break_glass",
]

// CreateRequestDialog — the manual申请 entry point on the workspace. The
// workspace gate (ApprovalRequestPanel) covers the common connect-time path;
// this covers申请 a user raises ahead of time or for non-connect business.
export function CreateRequestDialog() {
  const qc = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [biz, setBiz] = React.useState<ApprovalBusinessType>("asset_access")
  const [resourceType, setResourceType] = React.useState("node")
  const [resourceID, setResourceID] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [durationSec, setDurationSec] = React.useState(4 * 3600)

  const reset = () => {
    setTitle("")
    setReason("")
    setResourceID("")
    setDurationSec(4 * 3600)
  }

  const mut = useMutation({
    mutationFn: () =>
      approvalService.create({
        business_type: biz,
        title: title.trim(),
        reason: reason.trim(),
        resource_type: resourceType,
        resource_id: resourceID.trim(),
        window_end: new Date(Date.now() + durationSec * 1000).toISOString(),
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["approval"] })
      if (d.auto_approved) toast.success("已自动通过，授权已生效")
      else toast.success("申请已提交，等待审批")
      setOpen(false)
      reset()
    },
    onError: (e: { message?: string }) => toast.error(e.message || "提交失败"),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-1.5">
          <Plus className="h-4 w-4" /> 发起申请
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>发起审批申请</DialogTitle>
          <DialogDescription>说明你要做什么、对哪个资源、为什么。通过后系统会发放限时的访问授权。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">业务类型</Label>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {BIZ_ORDER.map((b) => {
                const Icon = BIZ_ICONS[b]
                return (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBiz(b)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
                      biz === b ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
                    )}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", biz === b ? "text-primary" : "text-muted-foreground")} />
                    <span className="truncate">{BIZ_LABELS[b]}</span>
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">{BIZ_HINTS[biz]}</p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">资源类型</Label>
              <Select value={resourceType} onValueChange={setResourceType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="node">节点</SelectItem>
                  <SelectItem value="credential">凭据</SelectItem>
                  <SelectItem value="session">会话</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">资源 ID</Label>
              <Input value={resourceID} onChange={(e) => setResourceID(e.target.value)} placeholder="例如 42" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">标题</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说明本次申请" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">申请事由</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="审批人会看到这段文字，写清业务背景与紧迫度更容易通过"
              className="resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">期望授权时长</Label>
            <DurationField value={durationSec} onChange={setDurationSec} />
            <p className="text-[11px] text-muted-foreground">这是你希望的时长，审批人可在此范围内调整。</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button className="gap-1.5" disabled={!resourceID.trim() || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} 提交
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
