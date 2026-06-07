"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Check, ClipboardList, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"

// Renders the agent's proposed plan (the exit_plan_mode handshake). Approving
// switches the conversation to execute mode server-side; rejecting asks the
// agent to revise. Self-contained: locks into a resolved state after the user
// decides so it survives further streaming.
export function PlanCard({
  plan,
  onApprove,
  onReject,
}: {
  plan: string
  onApprove: () => void
  onReject: () => void
}) {
  const reduce = useReducedMotion()
  const [decision, setDecision] = React.useState<null | "approved" | "rejected">(null)

  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
        <ClipboardList className="h-3.5 w-3.5" />
      </div>
      <motion.div
        className="min-w-0 max-w-3xl flex-1"
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 34 }}
      >
        <div className="overflow-hidden rounded-xl border border-primary/30 bg-primary/[0.03]">
          <div className="flex items-center justify-between border-b border-primary/15 px-4 py-2">
            <span className="eyebrow text-primary/80">执行计划 · 待你批准</span>
            {decision && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  decision === "approved"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {decision === "approved" ? "已批准 · 执行中" : "已驳回 · 待修订"}
              </span>
            )}
          </div>
          <div className="px-4 py-3">
            <div className="text-[13px]">
              <Markdown text={plan} />
            </div>
          </div>
          {!decision && (
            <div className="flex items-center gap-2 border-t border-primary/15 bg-primary/[0.04] px-4 py-2.5">
              <Button
                size="sm"
                onClick={() => {
                  setDecision("approved")
                  onApprove()
                }}
              >
                <Check className="h-3.5 w-3.5" /> 批准并执行
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDecision("rejected")
                  onReject()
                }}
              >
                <X className="h-3.5 w-3.5" /> 继续规划
              </Button>
              <span className="ml-auto text-[11px] text-muted-foreground">批准后将切换到执行模式</span>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}
