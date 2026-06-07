"use client"

import * as React from "react"
import { Download, Edit2, Loader2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { sftpService, type SftpEntry } from "@/lib/api/services"
import { fmtBytes } from "@/lib/format"
import { isLikelyText, isPreviewableImage } from "./fileIcons"
import { basename } from "./pathUtil"

type Props = {
  nodeId: number
  entry: SftpEntry | null
  onClose: () => void
  onEdit: (entry: SftpEntry) => void
}

export function SftpPreviewModal({ nodeId, entry, onClose, onEdit }: Props) {
  const [content, setContent] = React.useState<string | null>(null)
  const [truncated, setTruncated] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!entry) {
      setContent(null)
      setError(null)
      setTruncated(false)
      return
    }
    if (!isLikelyText(entry)) return
    setLoading(true)
    setError(null)
    let cancelled = false
    sftpService
      .readText(nodeId, entry.path)
      .then((r) => {
        if (cancelled) return
        setContent(r.content)
        setTruncated(r.truncated)
      })
      .catch((e: { message?: string }) => {
        if (cancelled) return
        const msg = e?.message || "无法读取"
        setError(msg)
        toast.error("预览失败", { description: msg })
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [entry, nodeId])

  const open = !!entry
  const isImg = entry ? isPreviewableImage(entry) : false
  const isText = entry ? isLikelyText(entry) : false

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl w-[min(960px,calc(100vw-2rem))] max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-row items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate">{entry ? basename(entry.path) : ""}</DialogTitle>
            <DialogDescription className="font-mono text-xs truncate">
              {entry?.path}
              {entry && (
                <span className="ml-2 text-muted-foreground">
                  · {fmtBytes(entry.size)}
                  {truncated && " · 已截断（仅显示前 2 MiB）"}
                </span>
              )}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {entry && isText && (
              <Button variant="outline" size="sm" onClick={() => onEdit(entry)}>
                <Edit2 className="w-4 h-4" /> 编辑
              </Button>
            )}
            {entry && (
              <Button variant="outline" size="sm" asChild>
                <a href={sftpService.downloadURL(nodeId, entry.path)} target="_blank" rel="noreferrer">
                  <Download className="w-4 h-4" /> 下载
                </a>
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/30">
          {!entry ? null : isImg ? (
            <div className="flex items-center justify-center p-4 min-h-[300px] bg-[length:16px_16px] bg-[linear-gradient(45deg,rgba(0,0,0,0.05)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.05)_75%),linear-gradient(45deg,rgba(0,0,0,0.05)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.05)_75%)] bg-[position:0_0,8px_8px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sftpService.downloadURL(nodeId, entry.path)}
                alt={entry.name}
                className="max-w-full max-h-[70vh] object-contain"
              />
            </div>
          ) : isText ? (
            loading ? (
              <div className="p-10 flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="w-4 h-4 animate-spin mr-2" /> 加载中…
              </div>
            ) : error ? (
              <div className="p-6 text-sm text-destructive">{error}</div>
            ) : (
              <pre className="text-xs p-4 whitespace-pre font-mono leading-5 min-w-max">{content}</pre>
            )
          ) : (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <p className="mb-2">此文件类型不支持内嵌预览。</p>
              <Button variant="outline" size="sm" asChild>
                <a href={sftpService.downloadURL(nodeId, entry.path)} target="_blank" rel="noreferrer">
                  <Download className="w-4 h-4" /> 下载到本地
                </a>
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
