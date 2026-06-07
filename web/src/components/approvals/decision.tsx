"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Check, ChevronDown, Loader2, UserCog, X } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { approvalService } from "@/lib/api/services"
import type { ApprovalTask, User } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { DurationField } from "./duration-field"
import { UserPicker } from "./user-picker"

// decision.tsx — every way an approver acts on a task, in one cohesive module:
//   DecisionPanel  — full form for the detail page
//   QuickDecide    — inline approve/reject/delegate for list rows
//   BulkDecideBar  — sticky bar to act on a selection at once
// All share the same comment + approver-duration affordance.

function errMsg(e: unknown): string {
  return (e as { message?: string })?.message || "操作失败"
}

// ---- shared comment + duration body ----

function CommentDuration({
  approve,
  comment,
  setComment,
  durationSec,
  setDurationSec,
}: {
  approve: boolean
  comment: string
  setComment: (v: string) => void
  durationSec: number
  setDurationSec: (v: number) => void
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">{approve ? "审批意见（可选）" : "驳回原因"}</Label>
        <Textarea
          autoFocus
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder={approve ? "记录通过的依据，便于日后追溯" : "说明驳回的原因，申请人会看到"}
          className="resize-none text-sm"
        />
      </div>
      {approve && (
        <div className="space-y-1.5">
          <Label className="text-xs">授权时长</Label>
          <DurationField value={durationSec} onChange={setDurationSec} allowDefault />
          <p className="text-[11px] text-muted-foreground">
            可缩短或延长本次授权，最终生效时长不会超过策略上限。
          </p>
        </div>
      )}
    </div>
  )
}

// ---- delegate dialog ----

function DelegateDialog({
  task,
  open,
  onOpenChange,
  onDone,
}: {
  task: ApprovalTask
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [comment, setComment] = React.useState("")
  const mut = useMutation({
    mutationFn: (u: User) => approvalService.delegate(task.id, u.id, comment),
    onSuccess: (_d, u) => {
      toast.success(`已转交给 ${u.display_name || u.username}`)
      onOpenChange(false)
      onDone()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>转交审批</DialogTitle>
          <DialogDescription>把这条任务交给更合适的同事处理，原任务将标记为已转交。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">附言（可选）</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="告诉对方为什么转交给 TA"
              className="resize-none text-sm"
            />
          </div>
          <UserPicker excludeId={task.approver_id} onPick={(u) => mut.mutate(u)} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---- detail-page panel ----

export function DecisionPanel({ task, onDone }: { task: ApprovalTask; onDone: () => void }) {
  const [comment, setComment] = React.useState("")
  const [durationSec, setDurationSec] = React.useState(0)
  const [delegating, setDelegating] = React.useState(false)

  const approve = useMutation({
    mutationFn: () => approvalService.approve(task.id, comment, durationSec),
    onSuccess: () => {
      toast.success("已通过")
      onDone()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const reject = useMutation({
    mutationFn: () => approvalService.reject(task.id, comment),
    onSuccess: () => {
      toast.success("已驳回")
      onDone()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const busy = approve.isPending || reject.isPending

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <CommentDuration
        approve
        comment={comment}
        setComment={setComment}
        durationSec={durationSec}
        setDurationSec={setDurationSec}
      />
      <div className="flex items-center gap-2 pt-1">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setDelegating(true)} disabled={busy}>
          <UserCog className="h-4 w-4" /> 转交
        </Button>
        <span className="flex-1" />
        <Button variant="outline" size="sm" className="gap-1.5 text-destructive" disabled={busy} onClick={() => reject.mutate()}>
          {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} 驳回
        </Button>
        <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => approve.mutate()}>
          {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} 通过
        </Button>
      </div>
      <DelegateDialog task={task} open={delegating} onOpenChange={setDelegating} onDone={onDone} />
    </div>
  )
}

// ---- inline quick-decide for list rows ----

function DecidePopover({
  task,
  approve,
  onDone,
  children,
}: {
  task: ApprovalTask
  approve: boolean
  onDone: () => void
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [comment, setComment] = React.useState("")
  const [durationSec, setDurationSec] = React.useState(0)
  const mut = useMutation({
    mutationFn: () =>
      approve ? approvalService.approve(task.id, comment, durationSec) : approvalService.reject(task.id, comment),
    onSuccess: () => {
      toast.success(approve ? "已通过" : "已驳回")
      setOpen(false)
      setComment("")
      onDone()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-80" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-3">
          <div className="text-sm font-medium">{approve ? "通过这条申请" : "驳回这条申请"}</div>
          <CommentDuration
            approve={approve}
            comment={comment}
            setComment={setComment}
            durationSec={durationSec}
            setDurationSec={setDurationSec}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              variant={approve ? "default" : "outline"}
              className={cn(!approve && "text-destructive")}
              disabled={mut.isPending || (!approve && !comment.trim())}
              onClick={() => mut.mutate()}
            >
              {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : approve ? "确认通过" : "确认驳回"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function QuickDecide({ task, onDone }: { task: ApprovalTask; onDone: () => void }) {
  const [delegating, setDelegating] = React.useState(false)
  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.preventDefault()}>
      <DecidePopover task={task} approve={false} onDone={onDone}>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-destructive">
          <X className="h-3.5 w-3.5" /> 驳回
        </Button>
      </DecidePopover>
      <DecidePopover task={task} approve onDone={onDone}>
        <Button size="sm" className="h-8 gap-1">
          <Check className="h-3.5 w-3.5" /> 通过
        </Button>
      </DecidePopover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setDelegating(true)} className="gap-2">
            <UserCog className="h-4 w-4" /> 转交他人
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DelegateDialog task={task} open={delegating} onOpenChange={setDelegating} onDone={onDone} />
    </div>
  )
}

// ---- bulk decide bar ----

function BulkDialog({
  taskIds,
  approve,
  open,
  onOpenChange,
  onDone,
}: {
  taskIds: number[]
  approve: boolean
  open: boolean
  onOpenChange: (v: boolean) => void
  onDone: () => void
}) {
  const [comment, setComment] = React.useState("")
  const [durationSec, setDurationSec] = React.useState(0)
  const mut = useMutation({
    mutationFn: () => approvalService.bulkDecide(taskIds, approve, comment, durationSec),
    onSuccess: (r) => {
      const failed = r.total - r.ok_count
      if (failed === 0) toast.success(`${r.ok_count} 条已${approve ? "通过" : "驳回"}`)
      else toast.warning(`${r.ok_count} 条成功，${failed} 条未处理`)
      onOpenChange(false)
      setComment("")
      onDone()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            批量{approve ? "通过" : "驳回"} {taskIds.length} 条申请
          </DialogTitle>
          <DialogDescription>同一意见将应用到所选的全部任务。</DialogDescription>
        </DialogHeader>
        <CommentDuration
          approve={approve}
          comment={comment}
          setComment={setComment}
          durationSec={durationSec}
          setDurationSec={setDurationSec}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant={approve ? "default" : "outline"}
            className={cn(!approve && "text-destructive")}
            disabled={mut.isPending || (!approve && !comment.trim())}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : `确认${approve ? "通过" : "驳回"}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function BulkDecideBar({
  taskIds,
  onClear,
  onDone,
}: {
  taskIds: number[]
  onClear: () => void
  onDone: () => void
}) {
  const [mode, setMode] = React.useState<null | "approve" | "reject">(null)
  if (taskIds.length === 0) return null
  return (
    <>
      <div className="sticky bottom-4 z-10 mx-auto flex w-fit items-center gap-3 rounded-full border bg-card/95 px-4 py-2 shadow-lg backdrop-blur">
        <span className="text-sm">
          已选 <span className="font-semibold text-primary">{taskIds.length}</span> 项
        </span>
        <Button variant="ghost" size="sm" onClick={onClear}>
          取消选择
        </Button>
        <span className="h-4 w-px bg-border" />
        <Button variant="outline" size="sm" className="gap-1 text-destructive" onClick={() => setMode("reject")}>
          <X className="h-3.5 w-3.5" /> 批量驳回
        </Button>
        <Button size="sm" className="gap-1" onClick={() => setMode("approve")}>
          <Check className="h-3.5 w-3.5" /> 批量通过
        </Button>
      </div>
      <BulkDialog
        taskIds={taskIds}
        approve={mode === "approve"}
        open={mode !== null}
        onOpenChange={(v) => !v && setMode(null)}
        onDone={() => {
          setMode(null)
          onClear()
          onDone()
        }}
      />
    </>
  )
}
