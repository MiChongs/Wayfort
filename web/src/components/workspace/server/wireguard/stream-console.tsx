"use client"

import * as React from "react"
import { Virtuoso } from "react-virtuoso"
import { CheckCircle2, Loader2, XCircle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { streamSSE } from "@/lib/sse/eventsource"
import { cn } from "@/lib/utils"

const MAX_LINES = 5000

type RunState = "running" | "ok" | "fail"

/**
 * StreamConsole — a Dialog that runs a POST SSE endpoint (event: line / done)
 * and scrolls its output live, like LogsTab's follower. Reused for the one-click
 * install and for applying a config change. Parses the terminal "===DONE rc=N==="
 * marker for success. Aborts cleanly on close/unmount.
 */
export function StreamConsole({
  open,
  title,
  description,
  url,
  body,
  onClose,
  onComplete,
}: {
  open: boolean
  title: string
  description?: React.ReactNode
  url: string
  body?: unknown
  onClose: () => void
  onComplete?: (ok: boolean) => void
}) {
  const [lines, setLines] = React.useState<string[]>([])
  const [state, setState] = React.useState<RunState>("running")
  const ctrlRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    if (!open) return
    setLines([])
    setState("running")
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    let rc = 0
    const push = (s: string) =>
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice()
        next.push(s)
        return next
      })

    const run = async () => {
      try {
        await streamSSE(url, { method: "POST", body: body ?? {}, signal: ctrl.signal }, (kind, payload) => {
          if (kind === "line") {
            const text = typeof payload === "string" ? payload : JSON.stringify(payload)
            const m = /^===DONE rc=(-?\d+)===/.exec(text)
            if (m) {
              rc = Number(m[1])
              return
            }
            push(text)
          } else if (kind === "err") {
            push(typeof payload === "string" ? payload : JSON.stringify(payload))
            rc = rc || 1
          } else if (kind === "done") {
            const ok = rc === 0
            setState(ok ? "ok" : "fail")
            onComplete?.(ok)
          }
        })
        // Stream ended without an explicit done frame.
        setState((s) => (s === "running" ? (rc === 0 ? "ok" : "fail") : s))
      } catch (e) {
        if (ctrl.signal.aborted) return
        push(e instanceof Error ? e.message : String(e))
        setState("fail")
        onComplete?.(false)
      }
    }
    void run()
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url])

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-tight">
            {title}
            {state === "running" && (
              <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
                <Loader2 className="h-3 w-3 animate-spin" /> 执行中
              </Badge>
            )}
            {state === "ok" && (
              <Badge className="h-5 gap-1 border-success/40 bg-success/[0.08] px-1.5 text-[10px] text-success">
                <CheckCircle2 className="h-3 w-3" /> 完成
              </Badge>
            )}
            {state === "fail" && (
              <Badge className="h-5 gap-1 border-destructive/40 bg-destructive/[0.08] px-1.5 text-[10px] text-destructive">
                <XCircle className="h-3 w-3" /> 失败
              </Badge>
            )}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="h-[min(48vh,360px)] overflow-hidden rounded-md border bg-muted/40">
          <Virtuoso
            data={lines}
            followOutput="auto"
            className="no-scrollbar h-full"
            itemContent={(_i, line) => (
              <div
                className={cn(
                  "whitespace-pre-wrap break-words px-3 py-px font-mono text-[11px] leading-5",
                  /error|fail|denied|未找到|权限/i.test(line) ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {line || " "}
              </div>
            )}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={state === "running"}>
            {state === "running" ? "执行中…" : "关闭"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
