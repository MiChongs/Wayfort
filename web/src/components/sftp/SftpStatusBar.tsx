import * as React from "react"
import { Activity, CheckCircle2, CircleAlert, FolderTree } from "lucide-react"
import { fmtBytes } from "@/lib/format"
import type { SftpEntry } from "@/lib/api/services"

type Props = {
  entries: SftpEntry[]
  selectedCount: number
  selectedSize: number
  loading?: boolean
  error?: string | null
  path: string
}

export function SftpStatusBar({ entries, selectedCount, selectedSize, loading, error, path }: Props) {
  const dirs = entries.filter((e) => e.is_dir).length
  const files = entries.length - dirs
  const total = entries.reduce((s, e) => s + (e.is_dir ? 0 : e.size), 0)

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-1.5 border-t bg-muted/40 text-xs text-muted-foreground select-none">
      <div className="flex items-center gap-3 min-w-0">
        <span className="inline-flex items-center gap-1 shrink-0">
          <FolderTree className="w-3.5 h-3.5" /> {dirs} 目录 · {files} 文件 · {fmtBytes(total)}
        </span>
        <span className="truncate font-mono opacity-70" title={path}>
          {path}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {selectedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-foreground">
            已选 {selectedCount} 项 · {fmtBytes(selectedSize)}
          </span>
        )}
        {loading ? (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <Activity className="w-3.5 h-3.5 animate-pulse" /> 同步中
          </span>
        ) : error ? (
          <span className="inline-flex items-center gap-1 text-destructive">
            <CircleAlert className="w-3.5 h-3.5" /> {error}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" /> 就绪
          </span>
        )}
      </div>
    </div>
  )
}
