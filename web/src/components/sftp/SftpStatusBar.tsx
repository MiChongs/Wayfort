"use client"

import * as React from "react"
import { Activity, CheckCircle2, CircleAlert, FolderTree, SearchCode } from "lucide-react"
import { fmtBytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { SftpEntry } from "@/lib/api/services"

type Props = {
  entries: SftpEntry[]
  selectedCount: number
  selectedSize: number
  loading?: boolean
  error?: string | null
  path: string
  searchSummary?: string | null
}

export function SftpStatusBar({
  entries,
  selectedCount,
  selectedSize,
  loading,
  error,
  path,
  searchSummary,
}: Props) {
  const dirs = entries.filter((e) => e.is_dir).length
  const files = entries.length - dirs
  const total = entries.reduce((s, e) => s + (e.is_dir ? 0 : e.size), 0)

  return (
    <div className="flex shrink-0 select-none items-center justify-between gap-4 border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-3">
        {searchSummary ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-foreground">
            <SearchCode className="h-3.5 w-3.5 text-primary" /> {searchSummary}
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <FolderTree className="h-3.5 w-3.5" /> {dirs} 目录 · {files} 文件 · {fmtBytes(total)}
          </span>
        )}
        <span className="truncate font-mono opacity-70" title={path}>
          {path}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {selectedCount > 0 && (
          <span className="text-foreground">
            已选 {selectedCount} 项 · {fmtBytes(selectedSize)}
          </span>
        )}
        {loading ? (
          <span className={cn("inline-flex items-center gap-1.5", "text-amber-600 dark:text-amber-400")}>
            <Activity className="h-3.5 w-3.5 animate-pulse" /> 同步中
          </span>
        ) : error ? (
          <span className="inline-flex items-center gap-1.5 text-destructive">
            <CircleAlert className="h-3.5 w-3.5" /> 出错
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> 就绪
          </span>
        )}
      </div>
    </div>
  )
}
