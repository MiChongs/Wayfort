"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Copy, Download, FileArchive, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { fmtBytes } from "@/lib/format"

// Slides in below the toolbar when rows are selected. Every action routes back
// through the workspace, which gates transfers behind the write grant — so a
// "下载" tap on a locked node opens the request sheet rather than 403-ing.
export function SftpSelectionBar({
  count,
  totalSize,
  fileCount,
  onDownload,
  onArchive,
  onDuplicate,
  onDelete,
  onClear,
}: {
  count: number
  totalSize: number
  fileCount: number
  onDownload: () => void
  onArchive: () => void
  onDuplicate: () => void
  onDelete: () => void
  onClear: () => void
}) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {count > 0 && (
        <motion.div
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduce ? undefined : { height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden border-b bg-primary/[0.05]"
        >
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span className="font-medium text-foreground">已选 {count} 项</span>
            {totalSize > 0 && <span className="text-muted-foreground">· {fmtBytes(totalSize)}</span>}
            <div className="ml-auto flex items-center gap-0.5">
              <Button size="sm" variant="ghost" className="h-7" disabled={fileCount === 0} onClick={onDownload}>
                <Download className="h-3.5 w-3.5" /> 下载
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={onArchive}>
                <FileArchive className="h-3.5 w-3.5" /> 打包下载
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={onDuplicate}>
                <Copy className="h-3.5 w-3.5" /> 复制
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-destructive hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" /> 删除
              </Button>
              <Separator orientation="vertical" className="mx-1 h-4" />
              <Button size="sm" variant="ghost" className="h-7" onClick={onClear}>
                <X className="h-3.5 w-3.5" /> 取消
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
