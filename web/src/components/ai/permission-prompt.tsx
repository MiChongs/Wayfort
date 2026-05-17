"use client"

import { motion, useReducedMotion } from "motion/react"
import { AlertTriangle, Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

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
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <motion.div
        className="flex-1 max-w-3xl"
        initial={reduce ? false : { x: 0 }}
        animate={reduce ? undefined : { x: [0, -4, 4, -2, 2, 0] }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        <motion.div
          animate={
            reduce
              ? undefined
              : {
                  boxShadow: [
                    "0 0 0 0 rgba(245,158,11,0)",
                    "0 0 0 4px rgba(245,158,11,0.18)",
                    "0 0 0 0 rgba(245,158,11,0)",
                  ],
                }
          }
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          className="rounded-xl"
        >
          <Card className="border-amber-500/60 bg-amber-500/5">
            <CardContent className="pt-4 pb-4 space-y-2">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-medium text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Agent 想调用工具</span>
                <code className="font-mono bg-amber-500/10 px-1.5 py-0.5 rounded text-xs">
                  {tool}
                </code>
              </div>
              <div className="text-sm text-foreground/90">{summary}</div>
              <div className="flex gap-2 pt-1">
                <motion.div whileTap={reduce ? undefined : { scale: 0.95 }}>
                  <Button size="sm" onClick={() => onApprove(invocationId)}>
                    <Check className="w-4 h-4" /> 同意一次
                  </Button>
                </motion.div>
                <motion.div whileTap={reduce ? undefined : { scale: 0.95 }}>
                  <Button size="sm" variant="outline" onClick={() => onReject(invocationId)}>
                    <X className="w-4 h-4" /> 拒绝
                  </Button>
                </motion.div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  )
}
