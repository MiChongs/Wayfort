"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Loader2, Lock, RotateCw, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SftpApproval } from "./useSftpApproval"

// Live "ms remaining" ticker for the granted countdown. Plain React state — the
// component is interactive, not a workflow script, so Date.now() is fine here.
function useRemaining(expiresAt?: string) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!expiresAt) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [expiresAt])
  if (!expiresAt) return null
  return Math.max(0, Date.parse(expiresAt) - now)
}

function fmtRemaining(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m}:${String(ss).padStart(2, "0")}`
}

// The persistent header strip reflecting the write-authorization machine. It's
// the only place the user learns "why is delete greyed out" — so it states the
// rule plainly and offers the one action that resolves it.
export function SftpApprovalBar({ approval, onApply }: { approval: SftpApproval; onApply: () => void }) {
  const { mode, expiresAt } = approval
  const remaining = useRemaining(expiresAt)
  const reduce = useReducedMotion()

  // open / checking → free to write or still resolving: no strip.
  if (mode === "open" || mode === "checking") return null

  const tone = mode === "granted" ? "ok" : "warn"

  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        key={mode}
        initial={reduce ? false : { opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        exit={reduce ? undefined : { opacity: 0, height: 0 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          "flex items-center gap-2.5 overflow-hidden border-b px-4 py-2 text-sm",
          tone === "ok"
            ? "bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300"
            : "bg-amber-500/[0.08] text-amber-700 dark:text-amber-300",
        )}
      >
        {mode === "granted" ? (
          <>
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <span className="font-medium">写入已授权</span>
            {remaining != null && (
              <span className="tabular-nums opacity-80">剩余 {fmtRemaining(remaining)}</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 text-current hover:bg-emerald-500/12 hover:text-current"
              onClick={onApply}
            >
              <RotateCw className="h-3.5 w-3.5" /> 续期
            </Button>
          </>
        ) : mode === "pending" ? (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span className="font-medium">写入授权审批中</span>
            <span className="hidden opacity-80 sm:inline">通过后自动解锁传输操作</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 text-current hover:bg-amber-500/12 hover:text-current"
              onClick={onApply}
            >
              查看进度
            </Button>
          </>
        ) : (
          <>
            <Lock className="h-4 w-4 shrink-0" />
            <span className="font-medium">写入受审批保护</span>
            <span className="hidden opacity-80 sm:inline">浏览可用；下载、上传、删除等操作需先申请授权</span>
            <Button size="sm" className="ml-auto h-7" onClick={onApply}>
              申请写入授权
            </Button>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
