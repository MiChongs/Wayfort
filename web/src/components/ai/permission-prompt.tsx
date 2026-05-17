"use client"

import { motion, useReducedMotion } from "motion/react"
import { AlertTriangle, Check, X } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { isDangerName } from "./tool-icons"

// Matches backend cfg.AI.ApprovalTimeout default. If overshoot the backend will
// time-out the invocation independently; we just render a visual countdown
// that approximates it.
const APPROVAL_TIMEOUT_SEC = 120

export function PermissionPrompt({
  invocationId,
  tool,
  summary,
  onApprove,
  onReject,
}: {
  invocationId: string
  tool: string
  summary: string
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const reduce = useReducedMotion()
  const danger = isDangerName(tool)
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <motion.div
        className="flex-1 max-w-3xl"
        initial={reduce ? false : { x: 0, opacity: 0 }}
        animate={
          reduce
            ? { opacity: 1 }
            : { x: [0, -5, 5, -3, 3, 0], opacity: 1 }
        }
        transition={reduce ? { duration: 0 } : { duration: 0.45, ease: "easeOut" }}
      >
        <Alert variant="warning" className="relative overflow-hidden pb-4">
          <AlertTriangle className="w-4 h-4" />
          <div>
            <div className="font-medium text-sm flex items-center gap-2 flex-wrap mb-1">
              <span>Agent 请求执行工具</span>
              <code className="font-mono bg-amber-500/15 px-1.5 py-0.5 rounded text-xs">
                {tool}
              </code>
              {danger && (
                <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-destructive text-destructive-foreground">
                  高危
                </span>
              )}
            </div>
            <AlertDescription className="text-foreground/90">
              {summary}
            </AlertDescription>
            <div className="flex gap-2 pt-3">
              <motion.div whileTap={reduce ? undefined : { scale: 0.95 }} className="inline-block">
                <Button size="sm" onClick={() => onApprove(invocationId)}>
                  <Check className="w-4 h-4" /> 同意一次
                </Button>
              </motion.div>
              <motion.div whileTap={reduce ? undefined : { scale: 0.95 }} className="inline-block">
                <Button size="sm" variant="outline" onClick={() => onReject(invocationId)}>
                  <X className="w-4 h-4" /> 拒绝
                </Button>
              </motion.div>
            </div>
          </div>
          {!reduce && (
            <motion.div
              className="absolute bottom-0 left-0 h-0.5 bg-amber-500/70 rounded-full"
              initial={{ width: "100%" }}
              animate={{ width: "0%" }}
              transition={{ duration: APPROVAL_TIMEOUT_SEC, ease: "linear" }}
            />
          )}
        </Alert>
      </motion.div>
    </div>
  )
}
