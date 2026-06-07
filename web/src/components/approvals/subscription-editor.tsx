"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { approvalService } from "@/lib/api/services"
import type { ApprovalBusinessType, ApprovalSubscription } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { BIZ_LABELS, CHANNEL_OPTIONS, SUBSCRIBABLE_EVENTS } from "@/lib/approvals/meta"

const TARGET_HINT: Record<string, string> = {
  webhook: "接收事件的 HTTPS URL",
  email: "收件邮箱地址",
  feishu: "飞书机器人 Webhook 地址",
  dingtalk: "钉钉机器人 Webhook 地址",
  wecom: "企业微信机器人 Webhook 地址",
  slack: "Slack Incoming Webhook 地址",
  teams: "Teams Connector Webhook 地址",
  siem: "SIEM 接收端点",
}

// SubscriptionEditor — create / edit a notification channel binding. Picks a
// channel, its target/secret, an optional business-type scope, and which events
// to forward (empty = all).
export function SubscriptionEditor({
  open,
  onOpenChange,
  subscription,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  subscription: ApprovalSubscription | null
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const editing = !!subscription

  const [name, setName] = React.useState("")
  const [channel, setChannel] = React.useState("feishu")
  const [target, setTarget] = React.useState("")
  const [secret, setSecret] = React.useState("")
  const [biz, setBiz] = React.useState<string>("")
  const [events, setEvents] = React.useState<Set<string>>(new Set())
  const [enabled, setEnabled] = React.useState(true)

  React.useEffect(() => {
    if (!open) return
    if (subscription) {
      setName(subscription.name)
      setChannel(subscription.channel)
      setTarget(subscription.target)
      setSecret(subscription.secret || "")
      setBiz(subscription.business_type || "")
      setEvents(new Set(subscription.event_mask ? subscription.event_mask.split(",").map((s) => s.trim()).filter(Boolean) : []))
      setEnabled(subscription.enabled)
    } else {
      setName("")
      setChannel("feishu")
      setTarget("")
      setSecret("")
      setBiz("")
      setEvents(new Set())
      setEnabled(true)
    }
  }, [open, subscription])

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        channel,
        target: target.trim(),
        secret: secret.trim() || undefined,
        business_type: (biz || undefined) as ApprovalBusinessType | undefined,
        event_mask: [...events].join(","),
        enabled,
      }
      return editing
        ? approvalService.subscriptions.update(subscription!.id, body)
        : approvalService.subscriptions.create(body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approval", "subscriptions"] })
      toast.success(editing ? "已保存" : "已添加通知渠道")
      onOpenChange(false)
      onSaved()
    },
    onError: (e: { message?: string }) => toast.error(e.message || "保存失败"),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑通知渠道" : "新增通知渠道"}</DialogTitle>
          <DialogDescription>审批事件发生时，向所选渠道推送卡片或消息。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 安全团队飞书群" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">渠道</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">目标地址</Label>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={TARGET_HINT[channel]} />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">签名密钥（可选）</Label>
            <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="用于校验 / 加签，留空则不启用" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">业务范围</Label>
            <Select value={biz || "all"} onValueChange={(v) => setBiz(v === "all" ? "" : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部业务类型</SelectItem>
                {Object.entries(BIZ_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">推送事件（不选 = 全部）</Label>
            <div className="flex flex-wrap gap-1.5">
              {SUBSCRIBABLE_EVENTS.map((ev) => {
                const on = events.has(ev.value)
                return (
                  <button
                    key={ev.value}
                    type="button"
                    onClick={() =>
                      setEvents((prev) => {
                        const next = new Set(prev)
                        if (on) next.delete(ev.value)
                        else next.add(ev.value)
                        return next
                      })
                    }
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-xs transition-colors",
                      on ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent",
                    )}
                  >
                    {ev.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
            <div className="text-sm font-medium">启用</div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={save.isPending || !name.trim() || !target.trim()} onClick={() => save.mutate()} className="gap-1.5">
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
