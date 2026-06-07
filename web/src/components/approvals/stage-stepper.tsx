"use client"

import * as React from "react"
import { Check, Clock, Minus, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { ApprovalTask } from "@/lib/api/types"
import { relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { stageModeLabel, taskStateMeta } from "@/lib/approvals/meta"

type StageState = "approved" | "rejected" | "active" | "skipped" | "idle"

function deriveStageState(tasks: ApprovalTask[]): StageState {
  if (tasks.length === 0) return "idle"
  let approved = 0
  let rejected = 0
  let pending = 0
  for (const t of tasks) {
    if (t.state === "approved") approved++
    else if (t.state === "rejected") rejected++
    else if (t.state === "pending" || t.state === "delegated") pending++
  }
  if (pending > 0) return "active"
  if (rejected > 0 && approved === 0) return "rejected"
  if (approved > 0) return "approved"
  return "skipped"
}

const STAGE_TONE: Record<StageState, { node: string; icon: React.ReactNode; label: string }> = {
  approved: { node: "border-emerald-500 bg-emerald-500 text-white", icon: <Check className="h-3.5 w-3.5" />, label: "已通过" },
  rejected: { node: "border-destructive bg-destructive text-white", icon: <X className="h-3.5 w-3.5" />, label: "已驳回" },
  active: { node: "border-primary bg-primary/10 text-primary", icon: <Clock className="h-3.5 w-3.5" />, label: "进行中" },
  skipped: { node: "border-border bg-muted text-muted-foreground", icon: <Minus className="h-3.5 w-3.5" />, label: "已跳过" },
  idle: { node: "border-border bg-card text-muted-foreground", icon: <Clock className="h-3.5 w-3.5" />, label: "待开始" },
}

// StageStepper renders the multi-stage approval flow as a vertical timeline,
// one node per stage with its mode and the per-approver task outcomes nested
// underneath. The caller passes the full task list; stages are grouped here.
export function StageStepper({
  tasks,
  totalStages,
  meUid,
}: {
  tasks: ApprovalTask[]
  totalStages: number
  meUid?: number
}) {
  const byStage = React.useMemo(() => {
    const m = new Map<number, ApprovalTask[]>()
    for (const t of tasks) {
      const arr = m.get(t.stage) ?? []
      arr.push(t)
      m.set(t.stage, arr)
    }
    return m
  }, [tasks])

  const stageCount = Math.max(totalStages, byStage.size, 1)
  const stages = Array.from({ length: stageCount }, (_, i) => i)

  return (
    <ol className="space-y-0">
      {stages.map((stage) => {
        const stageTasks = (byStage.get(stage) ?? []).slice().sort((a, b) => a.id - b.id)
        const state = deriveStageState(stageTasks)
        const tone = STAGE_TONE[state]
        const mode = stageTasks[0]?.stage_mode
        const last = stage === stageCount - 1
        return (
          <li key={stage} className="relative flex gap-3 pb-4 last:pb-0">
            {!last && <span className="absolute left-[15px] top-8 bottom-0 w-px bg-border" aria-hidden />}
            <span className={cn("z-10 mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border-2", tone.node)}>
              {tone.icon}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">第 {stage + 1} 级</span>
                {mode && (
                  <Badge variant="outline" className="text-[11px]">
                    {stageModeLabel(mode, stageTasks[0]?.quorum_n)}
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">{tone.label}</span>
              </div>
              {stageTasks.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">尚未指派审批人</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {stageTasks.map((t) => {
                    const sm = taskStateMeta(t.state)
                    const mine = meUid != null && t.approver_id === meUid
                    return (
                      <li key={t.id} className="flex items-start gap-2 text-sm">
                        <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", sm.dot)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="truncate">
                              {t.approver_role ? `${t.approver_role} 角色` : `用户 #${t.approver_id}`}
                              {mine && <span className="ml-1 text-primary">（你）</span>}
                            </span>
                            <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", sm.badge)}>{sm.label}</span>
                            {t.decided_at && (
                              <span className="text-xs text-muted-foreground">{relTime(t.decided_at)}</span>
                            )}
                          </div>
                          {t.comment && <p className="mt-0.5 text-xs text-muted-foreground">“{t.comment}”</p>}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
