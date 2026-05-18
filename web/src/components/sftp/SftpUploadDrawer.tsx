"use client"

import * as React from "react"
import { ChevronDown, ChevronUp, RotateCw, Trash2, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { fmtBytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { UploadTask } from "./useSftpUploadQueue"

type Props = {
  tasks: UploadTask[]
  active: UploadTask[]
  totalSent: number
  totalBytes: number
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onClearFinished: () => void
}

export function SftpUploadDrawer({
  tasks,
  active,
  totalSent,
  totalBytes,
  onCancel,
  onRetry,
  onClearFinished,
}: Props) {
  const [open, setOpen] = React.useState(true)
  if (tasks.length === 0) return null

  const pct = totalBytes > 0 ? Math.round((totalSent / totalBytes) * 100) : 100
  const succeeded = tasks.filter((t) => t.status === "done").length
  const failed = tasks.filter((t) => t.status === "error").length

  return (
    <div
      className={cn(
        "fixed right-4 z-40 w-[min(420px,calc(100vw-2rem))]",
        "rounded-lg border bg-card shadow-xl",
        "bottom-4",
      )}
      role="region"
      aria-label="上传队列"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 border-b text-sm"
      >
        <span className="inline-flex items-center gap-2">
          <Upload className={cn("w-4 h-4", active.length > 0 && "animate-pulse text-primary")} />
          <span className="font-medium">
            传输队列 {active.length > 0 ? `${active.length} 个进行中` : "全部完成"}
          </span>
          {active.length > 0 && (
            <span className="text-muted-foreground text-xs">
              {fmtBytes(totalSent)} / {fmtBytes(totalBytes)} · {pct}%
            </span>
          )}
        </span>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          {succeeded > 0 && <span className="text-emerald-600 dark:text-emerald-400">✓ {succeeded}</span>}
          {failed > 0 && <span className="text-destructive">✗ {failed}</span>}
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </span>
      </button>

      {open && (
        <>
          <ul className="max-h-72 overflow-y-auto divide-y">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} onCancel={onCancel} onRetry={onRetry} />
            ))}
          </ul>
          {(succeeded > 0 || failed > 0) && (
            <div className="p-2 border-t flex justify-end">
              <Button variant="ghost" size="sm" className="h-7" onClick={onClearFinished}>
                <Trash2 className="w-3.5 h-3.5" /> 清除已完成
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TaskRow({
  task,
  onCancel,
  onRetry,
}: {
  task: UploadTask
  onCancel: (id: string) => void
  onRetry: (id: string) => void
}) {
  const pct = task.size > 0 ? Math.round((task.sent / task.size) * 100) : 100
  const labelByStatus: Record<UploadTask["status"], string> = {
    pending: "等待中",
    uploading: `${pct}%`,
    done: "完成",
    error: "失败",
    cancelled: "已取消",
  }
  const tone: Record<UploadTask["status"], string> = {
    pending: "text-muted-foreground",
    uploading: "text-primary",
    done: "text-emerald-600 dark:text-emerald-400",
    error: "text-destructive",
    cancelled: "text-muted-foreground",
  }
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate" title={`${task.dest}/${task.name}`}>
          {task.name}
        </span>
        <span className={cn("text-xs shrink-0", tone[task.status])}>{labelByStatus[task.status]}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full transition-[width] duration-150 ease-out",
              task.status === "error" ? "bg-destructive" : task.status === "cancelled" ? "bg-muted-foreground/40" : "bg-primary",
            )}
            style={{ width: `${task.status === "done" ? 100 : pct}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground w-20 text-right">
          {fmtBytes(task.sent)} / {fmtBytes(task.size)}
        </span>
        {(task.status === "pending" || task.status === "uploading") && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onCancel(task.id)}
            title="取消"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {task.status === "error" && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onRetry(task.id)}
            title="重试"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {task.error && (
        <div className="mt-1 text-xs text-destructive truncate" title={task.error}>
          {task.error}
        </div>
      )}
    </li>
  )
}
