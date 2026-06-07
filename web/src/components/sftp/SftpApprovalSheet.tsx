"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Clock, Loader2, ShieldCheck, XCircle } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { relTime, fullTime } from "@/lib/format"
import { eventLabel, riskMeta } from "@/lib/approvals/meta"
import type { SftpApproval } from "./useSftpApproval"

const DURATIONS = [
  { label: "1 小时", sec: 3600 },
  { label: "4 小时", sec: 4 * 3600 },
  { label: "8 小时", sec: 8 * 3600 },
  { label: "一整天", sec: 24 * 3600 },
]
const EASE = [0.22, 1, 0.36, 1] as const

// SftpApprovalSheet drives the whole apply → wait → outcome flow for a node's
// write authorization. It reads its state off the shared useSftpApproval
// machine so the header bar and this sheet never disagree on what's in flight.
export function SftpApprovalSheet({
  open,
  onOpenChange,
  approval,
  title,
  subtitle,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  approval: SftpApproval
  title: string
  subtitle?: string
}) {
  const { requestId, stream, apply, cancelRequest, reapply, mode } = approval
  const detail = stream.data
  const status = detail?.request.status
  const renewing = mode === "granted"

  const [reason, setReason] = React.useState("")
  const [durationSec, setDurationSec] = React.useState(4 * 3600)
  const [customHours, setCustomHours] = React.useState("")
  const reduce = useReducedMotion()

  // Reset the draft each time the sheet re-opens onto a fresh apply form.
  React.useEffect(() => {
    if (open && (!requestId || renewing)) {
      setReason("")
      setCustomHours("")
      setDurationSec(4 * 3600)
    }
  }, [open, requestId, renewing])

  const settled = status === "rejected" || status === "cancelled" || status === "expired"
  const approved = status === "approved" || status === "auto_approved"
  const pending = !!requestId && !approved && !settled
  const showForm = renewing || !requestId || settled

  const submit = () => {
    if (!reason.trim()) {
      toast.error("请先填写申请事由")
      return
    }
    apply.mutate(
      { reason, durationSec },
      {
        onError: (e) => toast.error("提交失败", { description: (e as Error).message }),
        onSuccess: (out) => {
          if (out.auto_approved) {
            toast.success("已自动通过，写入已解锁")
            onOpenChange(false)
          }
        },
      },
    )
  }

  const customActive = !DURATIONS.some((d) => d.sec === durationSec)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[440px] flex-col gap-0 p-0 sm:max-w-[440px]">
        <SheetHeader className="space-y-1.5 border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2.5 text-base">
            <span
              className={cn(
                "grid h-8 w-8 place-items-center rounded-lg",
                approved
                  ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                  : pending
                    ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                    : "bg-primary/12 text-primary",
              )}
            >
              {approved ? (
                <ShieldCheck className="h-4 w-4" />
              ) : pending ? (
                <Clock className="h-4 w-4" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
            </span>
            {renewing ? "续期写入授权" : pending ? "等待写入审批" : "申请写入授权"}
          </SheetTitle>
          <SheetDescription className="text-[12px] leading-relaxed">
            {title}
            {subtitle ? ` · ${subtitle}` : ""} 的写操作开启了审批保护。通过后，这段时间内的上传、删除、改名、改权限都无需再次申请。
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait" initial={false}>
            {approved ? (
              <Outcome
                key="ok"
                reduce={!!reduce}
                tone="ok"
                icon={ShieldCheck}
                title="写入已授权"
                desc="现在可以上传、删除、重命名等操作了。授权到期后会自动回到只读。"
              />
            ) : pending ? (
              <motion.div
                key="pending"
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="px-5 py-5"
              >
                <PendingView detail={detail} stream={stream} />
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: EASE }}
                className="space-y-5 px-5 py-5"
              >
                {settled && (
                  <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {status === "rejected"
                      ? "上一次申请被驳回，可调整事由后重新提交。"
                      : status === "expired"
                        ? "上一次申请已超时，重新发起即可。"
                        : "上一次申请已撤销。"}
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label className="text-xs">申请事由</Label>
                  <Textarea
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="说明这次写操作的用途，方便审批人判断"
                    className="min-h-[88px] resize-none"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">有效时长</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {DURATIONS.map((d) => (
                      <Button
                        key={d.sec}
                        type="button"
                        variant={!customActive && durationSec === d.sec ? "default" : "outline"}
                        size="sm"
                        className="h-8"
                        onClick={() => {
                          setDurationSec(d.sec)
                          setCustomHours("")
                        }}
                      >
                        {d.label}
                      </Button>
                    ))}
                    <div
                      className={cn(
                        "flex h-8 items-center gap-1 rounded-md border px-2 text-sm transition-colors",
                        customActive && "border-primary bg-primary/10",
                      )}
                    >
                      <Input
                        value={customHours}
                        onChange={(e) => {
                          setCustomHours(e.target.value)
                          const h = Number(e.target.value)
                          if (h > 0) setDurationSec(Math.round(h * 3600))
                        }}
                        inputMode="numeric"
                        placeholder="自定义"
                        className="h-6 w-16 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
                      />
                      <span className="pr-1 text-xs text-muted-foreground">小时</span>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {showForm && !approved && (
          <div className="border-t px-5 py-4">
            <Button className="w-full" disabled={apply.isPending} onClick={submit}>
              {apply.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              {renewing ? "提交续期申请" : "提交申请"}
            </Button>
          </div>
        )}

        {pending && (
          <div className="border-t px-5 py-4">
            <Button
              variant="outline"
              className="w-full"
              disabled={cancelRequest.isPending}
              onClick={() => cancelRequest.mutate()}
            >
              {cancelRequest.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              撤销申请
            </Button>
          </div>
        )}

        {settled && requestId && (
          <div className="border-t px-5 py-4">
            <Button variant="ghost" className="w-full" onClick={reapply}>
              重新填写
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function PendingView({
  detail,
  stream,
}: {
  detail: SftpApproval["stream"]["data"]
  stream: SftpApproval["stream"]
}) {
  if (stream.isLoading || !detail) {
    return (
      <div className="grid place-items-center py-10 text-sm text-muted-foreground">
        <Loader2 className="mb-2 h-5 w-5 animate-spin" /> 读取审批状态…
      </div>
    )
  }
  const req = detail.request
  const risk = riskMeta(req.risk_level)
  const pendingApprovers = detail.tasks.filter((t) => t.state === "pending").length

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">已提交，等待审批</span>
            <Badge variant="outline" className={cn("ml-auto shrink-0", risk.badge)}>
              {risk.label}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {req.total_stages > 1
              ? `第 ${Math.min(req.current_stage + 1, req.total_stages)} / ${req.total_stages} 级审批`
              : "等待审批人处理"}
            {pendingApprovers > 0 ? ` · 待 ${pendingApprovers} 人` : ""}
          </p>
        </div>
      </div>

      {req.reason && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">申请事由</div>
          {req.reason}
        </div>
      )}

      <div>
        <Separator className="mb-3" />
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">处理记录</div>
        <ol className="space-y-2.5">
          {[...detail.events].reverse().map((ev) => (
            <li key={ev.id} className="flex items-start gap-2.5 text-sm">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
              <div className="min-w-0 flex-1">
                <span>{eventLabel(ev.kind)}</span>
                {ev.actor_name && <span className="text-muted-foreground"> · {ev.actor_name}</span>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground" title={fullTime(ev.created_at)}>
                {relTime(ev.created_at)}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function Outcome({
  tone,
  icon: Icon,
  title,
  desc,
  reduce,
}: {
  tone: "ok" | "bad"
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
  reduce: boolean
}) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.24, ease: EASE }}
      className="flex flex-col items-center px-6 py-12 text-center"
    >
      <span
        className={cn(
          "grid h-14 w-14 place-items-center rounded-2xl",
          tone === "ok"
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-destructive/10 text-destructive",
        )}
      >
        <Icon className="h-7 w-7" />
      </span>
      <h3 className="mt-4 text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 max-w-[18rem] text-sm text-muted-foreground">{desc}</p>
    </motion.div>
  )
}
