"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { CheckCircle2, ChevronUp, Loader2, RotateCw, X, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { fmtBytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import { iconForName } from "./fileIcons"
import type { UploadStatus, UploadTask } from "./useSftpUploadQueue"

const EASE = [0.22, 1, 0.36, 1] as const

type Props = {
  tasks: UploadTask[]
  uploadingCount: number
  doneCount: number
  failedCount: number
  pct: number
  hasActive: boolean
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onCancelAll: () => void
  onRetryFailed: () => void
  onClearFinished: () => void
}

// Bottom transfer dock — collapsed it's a one-line progress summary; expanded it
// reveals the queue with per-file controls. Mirrors the desktop drive dock so
// the two file surfaces feel like one product.
export function SftpTransferDock({
  tasks,
  uploadingCount,
  doneCount,
  failedCount,
  pct,
  hasActive,
  onCancel,
  onRetry,
  onCancelAll,
  onRetryFailed,
  onClearFinished,
}: Props) {
  const [expanded, setExpanded] = React.useState(false)
  const reduce = useReducedMotion()
  if (tasks.length === 0) return null

  const barText = hasActive
    ? `上传中 ${uploadingCount || tasks.filter((t) => t.status === "pending").length} 个 · ${pct}%`
    : `${doneCount} 个已完成${failedCount ? ` · ${failedCount} 个失败` : ""}`

  return (
    <div className="relative shrink-0 border-t bg-card">
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="absolute bottom-full left-0 right-0 flex max-h-[340px] flex-col border-t bg-card shadow-[0_-8px_24px_-12px_rgba(20,20,19,0.25)]"
          >
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
              <span className="font-medium">传输队列</span>
              <span className="text-muted-foreground">{tasks.length} 项</span>
              <div className="ml-auto flex items-center gap-1">
                {failedCount > 0 && (
                  <Button size="sm" variant="ghost" className="h-7" onClick={onRetryFailed}>
                    <RotateCw className="h-3.5 w-3.5" /> 重试失败
                  </Button>
                )}
                {hasActive && (
                  <Button size="sm" variant="ghost" className="h-7" onClick={onCancelAll}>
                    全部取消
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-7" onClick={onClearFinished}>
                  清除已完成
                </Button>
              </div>
            </div>
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
              {tasks.map((t) => (
                <TransferRow key={t.id} task={t} onCancel={() => onCancel(t.id)} onRetry={() => onRetry(t.id)} />
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
          {hasActive ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : failedCount ? (
            <XCircle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-[12px] font-medium">{barText}</span>
          {hasActive && (
            <Progress value={pct} className="mt-1 h-1" />
          )}
        </div>
        <ChevronUp className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>
    </div>
  )
}

const STATUS_META: Record<UploadStatus, { label: string; tone: string }> = {
  pending: { label: "排队中", tone: "text-muted-foreground" },
  uploading: { label: "上传中", tone: "text-primary" },
  done: { label: "完成", tone: "text-emerald-600 dark:text-emerald-400" },
  error: { label: "失败", tone: "text-destructive" },
  cancelled: { label: "已取消", tone: "text-muted-foreground" },
}

function TransferRow({
  task,
  onCancel,
  onRetry,
}: {
  task: UploadTask
  onCancel: () => void
  onRetry: () => void
}) {
  const meta = STATUS_META[task.status]
  const pct = task.size > 0 ? Math.round((task.sent / task.size) * 100) : task.status === "done" ? 100 : 0
  const Icon = iconForName(task.name)
  const active = task.status === "uploading" || task.status === "pending"

  return (
    <li className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]" title={`${task.dest}/${task.name}`}>
            {task.name}
          </span>
          <span className={cn("shrink-0 text-[10px] font-medium", meta.tone)}>{meta.label}</span>
        </div>
        {task.status === "error" ? (
          <span className="block truncate text-[11px] text-destructive" title={task.error}>
            {task.error || "上传失败"}
          </span>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            <Progress
              value={task.status === "done" ? 100 : pct}
              className="h-1 flex-1"
              indicatorClassName={cn(
                task.status === "done"
                  ? "bg-emerald-500"
                  : task.status === "cancelled"
                    ? "bg-muted-foreground/40"
                    : "bg-primary",
              )}
            />
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {task.status === "uploading" ? `${fmtBytes(task.sent)} / ${fmtBytes(task.size)}` : fmtBytes(task.size)}
            </span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {active ? (
          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={onCancel} aria-label="取消">
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : task.status === "error" ? (
          <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={onRetry} aria-label="重试">
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        ) : task.status === "done" ? (
          <span className="grid h-7 w-7 place-items-center text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
    </li>
  )
}
