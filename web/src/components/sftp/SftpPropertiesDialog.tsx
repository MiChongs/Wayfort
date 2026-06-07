"use client"

import * as React from "react"
import { Copy, Loader2 } from "lucide-react"
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
import { sftpService, type SftpEntry } from "@/lib/api/services"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { basename } from "./pathUtil"

type Props = {
  nodeId: number
  entry: SftpEntry | null
  onClose: () => void
}

// Re-fetches stat on open so the dialog reflects post-rename/chmod state
// (the list cache might be a tick stale).
export function SftpPropertiesDialog({ nodeId, entry, onClose }: Props) {
  const [info, setInfo] = React.useState<SftpEntry | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!entry) {
      setInfo(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    let cancelled = false
    sftpService
      .stat(nodeId, entry.path)
      .then((r) => !cancelled && setInfo(r))
      .catch((e: { message?: string }) => !cancelled && setError(e?.message || "查询失败"))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [entry, nodeId])

  const data = info ?? entry

  const kind = data?.is_link ? "符号链接" : data?.is_dir ? "目录" : "文件"
  const copy = (s: string) => {
    void navigator.clipboard?.writeText(s)
    toast.success("已复制", { description: s })
  }

  return (
    <Dialog open={!!entry} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? basename(entry.path) : ""}</DialogTitle>
          <DialogDescription className="font-mono text-xs">属性</DialogDescription>
        </DialogHeader>

        {loading && !data ? (
          <div className="flex items-center text-muted-foreground text-sm py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> 查询中…
          </div>
        ) : error ? (
          <div className="text-sm text-destructive py-2">{error}</div>
        ) : data ? (
          <div className="grid grid-cols-[6rem_1fr_auto] gap-y-2 gap-x-3 text-sm py-2 items-center">
            <Row label="类型">{kind}</Row>
            <Row label="路径" copy={() => copy(data.path)} copyValue={data.path}>
              <span className="font-mono text-xs break-all">{data.path}</span>
            </Row>
            <Row label="大小">
              <span className="tabular-nums">
                {fmtBytes(data.size)}{" "}
                <span className="text-xs text-muted-foreground">({data.size.toLocaleString()} B)</span>
              </span>
            </Row>
            <Row label="权限">
              <span className="font-mono">{data.mode_octal || data.mode}</span>
              <span className="text-xs text-muted-foreground ml-2">{data.mode}</span>
            </Row>
            <Row label="所有者">
              <span>{data.owner || "—"}</span>
              {data.uid != null && <span className="text-xs text-muted-foreground ml-1">(uid {data.uid})</span>}
            </Row>
            <Row label="用户组">
              <span>{data.group || "—"}</span>
              {data.gid != null && <span className="text-xs text-muted-foreground ml-1">(gid {data.gid})</span>}
            </Row>
            <Row label="修改时间">
              <span>{fullTime(data.mod_time)}</span>
              <span className="text-xs text-muted-foreground ml-2">{relTime(data.mod_time)}</span>
            </Row>
            {data.is_link && (
              <Row label="链接目标" copy={data.link_target ? () => copy(data.link_target!) : undefined} copyValue={data.link_target}>
                <span className="font-mono text-xs break-all">{data.link_target || "—"}</span>
              </Row>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({
  label,
  children,
  copy,
  copyValue,
}: {
  label: string
  children: React.ReactNode
  copy?: () => void
  copyValue?: string
}) {
  return (
    <>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="min-w-0">{children}</div>
      <div>
        {copy && copyValue && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground"
            onClick={copy}
            title="复制"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </>
  )
}
