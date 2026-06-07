"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  Gauge,
  Loader2,
  RefreshCw,
  Search as SearchIcon,
  Signal as SignalIcon,
  TerminalSquare,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useConfirm } from "@/components/admin/use-confirm"
import { usagePctTone, formatBytes } from "@/components/insights/format"
import { processService } from "@/lib/api/services"
import type { ProcRow, ProcSignal, ProcSort } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { RunInTerminalButton, codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

const SORTS: { value: ProcSort; label: string }[] = [
  { value: "cpu", label: "按 CPU" },
  { value: "mem", label: "按内存" },
  { value: "rss", label: "按 RSS" },
  { value: "pid", label: "按 PID" },
]

// Signals offered in the row menu. Destructive ones are confirmed.
const SIGNALS: { sig: ProcSignal; label: string; danger?: boolean }[] = [
  { sig: "TERM", label: "TERM（优雅终止）" },
  { sig: "HUP", label: "HUP（重载）" },
  { sig: "INT", label: "INT（中断）" },
  { sig: "STOP", label: "STOP（暂停）" },
  { sig: "CONT", label: "CONT（恢复）" },
  { sig: "KILL", label: "KILL（强杀 -9）", danger: true },
]

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|not permitted/i.test(msg))
    return "SSH 用户无权操作该进程。换 root 凭据，或用「在终端运行」以当前 shell 提权执行。"
  if (code === "unreachable") return "节点 SSH 不可达，检查节点状态、代理链与凭据。"
  if (code === "bad_pid") return "进程不存在或已退出。"
  return ""
}

export function ProcessesTab({ nodeId, tabId, active }: Props) {
  const qc = useQueryClient()
  const [sort, setSort] = React.useState<ProcSort>("cpu")
  const [search, setSearch] = React.useState("")
  const [detailPid, setDetailPid] = React.useState<number | null>(null)
  const { confirm, dialog } = useConfirm()

  const list = useQuery({
    queryKey: ["process", nodeId, "list", sort],
    queryFn: () => processService.list(nodeId, sort),
    enabled: active,
    refetchInterval: 5000,
    retry: false,
  })

  const invalidate = React.useCallback(
    () => void qc.invalidateQueries({ queryKey: ["process", nodeId] }),
    [nodeId, qc],
  )

  const signal = useMutation({
    mutationFn: ({ pid, sig }: { pid: number; sig: ProcSignal }) => processService.signal(nodeId, pid, sig),
    onSuccess: (_d, v) => {
      toast.success(`已发送 ${v.sig} 至 #${v.pid}`)
      invalidate()
    },
    onError: (e: ApiError) => toast.error("发送信号失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })
  const renice = useMutation({
    mutationFn: ({ pid, nice }: { pid: number; nice: number }) => processService.renice(nodeId, pid, nice),
    onSuccess: (_d, v) => {
      toast.success(`#${v.pid} 优先级 → ${v.nice}`)
      invalidate()
    },
    onError: (e: ApiError) => toast.error("renice 失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  const onSignal = async (pid: number, sig: ProcSignal, comm: string) => {
    const meta = SIGNALS.find((s) => s.sig === sig)
    if (meta?.danger) {
      const ok = await confirm({
        title: `强杀 ${comm} (#${pid})？`,
        description: "KILL (-9) 立即终止进程，未保存数据会丢失，子进程可能变孤儿。",
        confirmLabel: "强杀",
      })
      if (!ok) return
    }
    signal.mutate({ pid, sig })
  }

  const rows = React.useMemo(() => {
    const all = list.data?.processes ?? []
    const q = search.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (p) => p.comm.toLowerCase().includes(q) || p.args.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid).includes(q),
    )
  }, [list.data, search])

  if (!active) return null

  if (list.isError) {
    const e = list.error as ApiError
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Gauge className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法读取进程</div>
        <div className="text-xs">{e?.message}</div>
        {errorHint(codeOf(e), e?.message || "") && <div className="text-xs text-foreground/80">{errorHint(codeOf(e), e?.message || "")}</div>}
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => list.refetch()}>
          <RefreshCw className="w-3 h-3" /> 重试
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {dialog}
      <div className="px-2 py-1.5 border-b flex items-center gap-1.5">
        <Select value={sort} onValueChange={(v) => setSort(v as ProcSort)}>
          <SelectTrigger className="h-7 w-auto min-w-0 gap-1 text-[11px] border-border/60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-0">
          <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="过滤 pid/命令/用户…" className="h-7 pl-7 text-xs" />
        </div>
        <Badge variant="outline" className="text-[10px] shrink-0">{list.data?.total ?? 0}</Badge>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => invalidate()} title="刷新">
          <RefreshCw className={cn("w-3 h-3", list.isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {list.isLoading ? (
          <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载进程…</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted-foreground p-6 text-center">无匹配进程</div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="bg-muted/40 sticky top-0 text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1.5 w-14">PID</th>
                <th className="text-left px-2 py-1.5 w-16">用户</th>
                <th className="text-right px-2 py-1.5 w-12">CPU</th>
                <th className="text-right px-2 py-1.5 w-12">内存</th>
                <th className="text-left px-2 py-1.5">命令</th>
                <th className="text-right px-2 py-1.5 w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((p) => (
                <ProcRowView
                  key={p.pid}
                  p={p}
                  tabId={tabId}
                  busy={signal.isPending || renice.isPending}
                  onSignal={(sig) => onSignal(p.pid, sig, p.comm)}
                  onRenice={(nice) => renice.mutate({ pid: p.pid, nice })}
                  onDetail={() => setDetailPid(p.pid)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <DetailSheet nodeId={nodeId} pid={detailPid} onClose={() => setDetailPid(null)} />
    </div>
  )
}

function ProcRowView({
  p,
  tabId,
  busy,
  onSignal,
  onRenice,
  onDetail,
}: {
  p: ProcRow
  tabId: string
  busy: boolean
  onSignal: (sig: ProcSignal) => void
  onRenice: (nice: number) => void
  onDetail: () => void
}) {
  return (
    <tr className="hover:bg-accent/40">
      <td className="px-2 py-1 tabular-nums font-mono">{p.pid}</td>
      <td className="px-2 py-1 truncate max-w-[5rem]" title={p.user}>{p.user}</td>
      <td className={cn("px-2 py-1 text-right tabular-nums", usagePctTone(p.cpu_pct))}>{p.cpu_pct.toFixed(1)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{p.mem_pct.toFixed(1)}</td>
      <td className="px-2 py-1 min-w-0">
        <button type="button" onClick={onDetail} className="font-mono truncate max-w-[14rem] hover:text-primary text-left block" title={p.args || p.comm}>
          {p.comm}
        </button>
      </td>
      <td className="px-2 py-1 text-right">
        <div className="inline-flex gap-0.5">
          <RunInTerminalButton tabId={tabId} command={`strace -p ${p.pid}`} label="在终端 strace -p" />
          <RenicePopover current={p.nice} busy={busy} onApply={onRenice} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" title="发送信号" disabled={busy}>
                <SignalIcon className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuLabel className="text-[10px] text-muted-foreground">信号</DropdownMenuLabel>
              {SIGNALS.map((s) => (
                <React.Fragment key={s.sig}>
                  {s.danger && <DropdownMenuSeparator />}
                  <DropdownMenuItem className={s.danger ? "text-destructive focus:text-destructive" : ""} onClick={() => onSignal(s.sig)}>
                    {s.label}
                  </DropdownMenuItem>
                </React.Fragment>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDetail}>
                <ChevronDown className="w-3.5 h-3.5" /> 详情
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  )
}

function RenicePopover({ current, busy, onApply }: { current: number; busy: boolean; onApply: (nice: number) => void }) {
  const [open, setOpen] = React.useState(false)
  const [val, setVal] = React.useState(current)
  React.useEffect(() => { if (open) setVal(current) }, [open, current])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6" title={`renice（当前 ${current}）`} disabled={busy}>
          <Gauge className="w-3 h-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3 space-y-2">
        <div className="text-xs font-medium">调整优先级 (nice)</div>
        <div className="flex items-center gap-2">
          <input type="range" min={-20} max={19} value={val} onChange={(e) => setVal(Number(e.target.value))} className="flex-1 accent-[#cc785c]" />
          <span className="w-8 text-right tabular-nums text-xs">{val}</span>
        </div>
        <div className="text-[10px] text-muted-foreground">越低越优先（-20 最高）。降低需 root。</div>
        <Button size="sm" className="h-7 w-full text-xs" onClick={() => { onApply(val); setOpen(false) }}>应用</Button>
      </PopoverContent>
    </Popover>
  )
}

function DetailSheet({ nodeId, pid, onClose }: { nodeId: number; pid: number | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["process", nodeId, "detail", pid],
    queryFn: () => processService.detail(nodeId, pid as number),
    enabled: pid != null,
    refetchInterval: 5000,
    retry: false,
  })
  const d = detail.data
  return (
    <Sheet open={pid != null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[min(560px,calc(100vw-2rem))] sm:max-w-none flex flex-col gap-3">
        <SheetHeader>
          <SheetTitle>进程 #{pid}</SheetTitle>
          <SheetDescription className="truncate" title={d?.cmdline || ""}>{d?.status?.Name || "进程详情"}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-1 space-y-4">
          {detail.isLoading && <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4"><Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载…</div>}
          {detail.isError && <div className="text-xs text-destructive py-2">{(detail.error as ApiError)?.message}</div>}
          {d && (
            <>
              <dl className="text-[11px] grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
                {Object.entries(d.status).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-mono truncate" title={v}>{v}</dd>
                  </React.Fragment>
                ))}
                <dt className="text-muted-foreground">打开 FD</dt>
                <dd className="font-mono">{d.fd_count}</dd>
                {(d.io_read_bytes || d.io_write_bytes) ? (
                  <>
                    <dt className="text-muted-foreground">磁盘 IO</dt>
                    <dd className="font-mono">读 {formatBytes((d.io_read_bytes ?? 0) / 1024)} · 写 {formatBytes((d.io_write_bytes ?? 0) / 1024)}</dd>
                  </>
                ) : null}
              </dl>
              {d.cmdline && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">命令行</div>
                  <pre className="bg-muted/60 rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words">{d.cmdline}</pre>
                </div>
              )}
              {d.limits && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">资源限制</div>
                  <pre className="bg-muted/60 rounded-md p-2 text-[10px] font-mono whitespace-pre overflow-x-auto max-h-48">{d.limits}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
