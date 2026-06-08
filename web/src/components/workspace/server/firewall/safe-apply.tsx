"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Loader2, RotateCcw, ShieldCheck } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { firewallService } from "@/lib/api/services"
import type { FirewallApplyRequest, FirewallArmResult } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "../_shared"
import { errorHint } from "./shared"

type ArmPending = { res: FirewallArmResult; summary: React.ReactNode }
type Phase = "counting" | "kept" | "rolledback"

/**
 * useSafeApply runs a firewall change with auto-rollback protection. High-risk
 * changes (default-deny, touching the SSH port, templates, imports) come back
 * "armed": the node will revert in N seconds unless the operator confirms they
 * are still connected. Returns { run, modal } — mount modal once, call run(req).
 */
export function useSafeApply(nodeId: number, onApplied?: () => void) {
  const qc = useQueryClient()
  const [arm, setArm] = React.useState<ArmPending | null>(null)
  const [phase, setPhase] = React.useState<Phase>("counting")
  const [remaining, setRemaining] = React.useState(0)

  const apply = useMutation({
    mutationFn: (req: FirewallApplyRequest) => firewallService.apply(nodeId, req),
    onSuccess: (res, req) => {
      if (res.high_risk && res.arm_token) {
        setPhase("counting")
        setRemaining(res.window_seconds || 60)
        setArm({ res, summary: req.kind })
      } else {
        toast.success("已应用")
        onApplied?.()
      }
      void qc.invalidateQueries({ queryKey: ["fw", nodeId] })
    },
    onError: (e: ApiError) =>
      toast.error("应用失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  const commit = useMutation({
    mutationFn: (token: string) => firewallService.commit(nodeId, token),
    onSuccess: () => {
      setPhase("kept")
      toast.success("已保留并固化")
      onApplied?.()
      setTimeout(() => setArm(null), 800)
    },
    onError: (e: ApiError) => toast.error("提交失败", { description: e?.message }),
  })

  const rollback = useMutation({
    mutationFn: (token: string) => firewallService.rollback(nodeId, token),
    onSuccess: () => {
      setPhase("rolledback")
      toast.success("已回滚到改动前")
      onApplied?.()
      setTimeout(() => setArm(null), 800)
    },
    onError: (e: ApiError) => toast.error("回滚失败", { description: e?.message }),
  })

  // countdown
  React.useEffect(() => {
    if (!arm || phase !== "counting") return
    if (remaining <= 0) {
      setPhase("rolledback")
      return
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000)
    return () => clearTimeout(t)
  }, [arm, phase, remaining])

  const run = React.useCallback(
    (req: FirewallApplyRequest, _summary?: React.ReactNode) => apply.mutate(req),
    [apply],
  )

  const token = arm?.res.arm_token ?? ""
  const danger = remaining <= 10

  const modal = (
    <Dialog open={!!arm} onOpenChange={() => { /* not dismissible while counting */ }}>
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-tight">
            {phase === "kept" ? (
              <><ShieldCheck className="h-4 w-4 text-success" /> 已保留</>
            ) : phase === "rolledback" ? (
              <><RotateCcw className="h-4 w-4 text-warning" /> 已回滚</>
            ) : (
              <><AlertTriangle className="h-4 w-4 text-warning" /> 高危改动 · 安全应用</>
            )}
          </DialogTitle>
          <DialogDescription>
            {phase === "counting"
              ? "规则已应用。如果你仍能连通，请在倒计时结束前点击「我仍连通，保留」，否则节点将自动回滚到改动前。"
              : phase === "kept"
                ? "改动已固化并持久化。"
                : "节点已恢复到改动前的状态。"}
          </DialogDescription>
        </DialogHeader>

        {phase === "counting" && (
          <div className="flex flex-col items-center gap-2 py-2">
            <div className={cn("text-4xl font-semibold tabular-nums", danger ? "text-destructive" : "text-warning", danger && "animate-pulse")}>
              {remaining}s
            </div>
            {arm?.res.ssh_guard && (
              <div className="text-[10px] text-muted-foreground">已置顶放行：{arm.res.ssh_guard}</div>
            )}
            <p className="rounded-md border border-warning/30 bg-warning/[0.05] px-2.5 py-2 text-center text-[11px] text-muted-foreground">
              即使此浏览器崩溃或断网，节点也会在倒计时结束后自动恢复——你不会被锁在门外。
              （回滚机制：{arm?.res.rollback_via || "host watchdog"}）
            </p>
          </div>
        )}

        {phase === "counting" && (
          <DialogFooter className="flex-row justify-between sm:justify-between">
            <Button variant="outline" size="sm" disabled={rollback.isPending} onClick={() => rollback.mutate(token)}>
              {rollback.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} 立即回滚
            </Button>
            <Button size="sm" disabled={commit.isPending} onClick={() => commit.mutate(token)}>
              {commit.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} 我仍连通，保留
            </Button>
          </DialogFooter>
        )}
        {phase !== "counting" && (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setArm(null)}>关闭</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )

  return { run, modal, pending: apply.isPending }
}
