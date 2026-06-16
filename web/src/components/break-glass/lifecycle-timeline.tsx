"use client"

import * as React from "react"
import {
  Activity,
  CheckCircle2,
  Clock,
  LifeBuoy,
  ListChecks,
  ShieldCheck,
  ShieldX,
  Slash,
  TimerOff,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BreakGlassActivation } from "@/lib/api/types"

type StepState = "done" | "current" | "pending" | "danger"

interface Step {
  key: string
  label: string
  at?: string | null
  state: StepState
  icon: LucideIcon
}

function buildSteps(a: BreakGlassActivation): Step[] {
  const granted = !!a.activated_at
  const ended = ["expired", "revoked", "under_review", "closed"].includes(a.status)
  const steps: Step[] = []

  steps.push({ key: "request", label: "发起申请", at: a.created_at, state: "done", icon: LifeBuoy })

  // Rejected / cancelled before access — short-circuit the chain.
  if (a.status === "rejected") {
    steps.push({
      key: "rejected",
      label: a.revoked_at ? "已被吊销 / 取消" : "审批被驳回",
      at: a.revoked_at ?? a.updated_at,
      state: "danger",
      icon: Slash,
    })
    return steps
  }

  if (a.mode === "fail_open") {
    steps.push({
      key: "activate",
      label: "自助破玻璃开通",
      at: a.activated_at,
      state: granted ? "done" : "current",
      icon: Zap,
    })
  } else {
    steps.push({
      key: "approve",
      label: granted ? "审批通过" : "等待审批",
      at: a.activated_at,
      state: granted ? "done" : "current",
      icon: granted ? ShieldCheck : Clock,
    })
  }

  steps.push({
    key: "active",
    label: "访问进行中",
    at: a.activated_at,
    state: a.status === "active" ? "current" : granted ? "done" : "pending",
    icon: Activity,
  })

  if (a.revoked_at) {
    steps.push({ key: "end", label: "被管理员吊销", at: a.revoked_at, state: "danger", icon: ShieldX })
  } else {
    steps.push({
      key: "end",
      label: "时窗到期",
      at: a.not_after,
      state: ended ? "done" : "pending",
      icon: TimerOff,
    })
  }

  if (a.review_required) {
    steps.push({
      key: "review",
      label: a.reviewed_at ? "已复核" : "待复核",
      at: a.reviewed_at,
      state: a.reviewed_at ? "done" : a.status === "under_review" ? "current" : "pending",
      icon: ListChecks,
    })
  }

  steps.push({
    key: "closed",
    label: "闭环",
    at: a.status === "closed" ? a.updated_at : undefined,
    state: a.status === "closed" ? "done" : "pending",
    icon: CheckCircle2,
  })

  return steps
}

const STATE_STYLES: Record<StepState, { ring: string; icon: string; line: string; label: string }> = {
  done: {
    ring: "border-emerald-400 bg-emerald-500/10",
    icon: "text-emerald-600",
    line: "bg-emerald-400/50",
    label: "text-foreground",
  },
  current: {
    ring: "border-orange-400 bg-orange-500/10 ring-2 ring-orange-400/30",
    icon: "text-orange-500",
    line: "bg-border",
    label: "text-foreground font-medium",
  },
  danger: {
    ring: "border-destructive/50 bg-destructive/10",
    icon: "text-destructive",
    line: "bg-border",
    label: "text-foreground",
  },
  pending: {
    ring: "border-border bg-muted/40",
    icon: "text-muted-foreground/60",
    line: "bg-border",
    label: "text-muted-foreground",
  },
}

// LifecycleTimeline renders the break-glass activation as a vertical,
// timestamped lifecycle so the whole story (发起 → 开通 → 到期 → 复核 → 闭环)
// reads at a glance.
export function LifecycleTimeline({ activation, className }: { activation: BreakGlassActivation; className?: string }) {
  const steps = buildSteps(activation)
  return (
    <ol className={cn("space-y-0", className)}>
      {steps.map((step, i) => {
        const st = STATE_STYLES[step.state]
        const Icon = step.icon
        const last = i === steps.length - 1
        return (
          <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
            {!last && (
              <span className={cn("absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px", st.line)} aria-hidden />
            )}
            <span
              className={cn(
                "z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                st.ring,
              )}
            >
              <Icon className={cn("h-4 w-4", st.icon)} />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className={cn("text-sm", st.label)}>{step.label}</div>
              {step.at ? (
                <div className="text-xs text-muted-foreground" title={fullTime(step.at)}>
                  {relTime(step.at)}
                </div>
              ) : step.state === "current" ? (
                <div className="text-xs text-orange-500">进行中…</div>
              ) : (
                <div className="text-xs text-muted-foreground/50">待发生</div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
