"use client"

import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  ChevronDown,
  Gauge,
  Loader2,
  Search as SearchIcon,
  Signal as SignalIcon,
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
import { VirtualTable } from "@/components/common/virtual-table"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { processService } from "@/lib/api/services"
import type { ProcRow, ProcSignal, ProcSort } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { RunInTerminalButton, codeOf, type ApiError } from "./_shared"
import { LiveKpiStrip, processStreamURL } from "./_live"

type Props = { nodeId: number; tabId: string; active: boolean }
type ProcessList = { processes: ProcRow[]; total: number }

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
  if (code === "unreachable" || /unreachable/i.test(msg)) return "节点 SSH 不可达，检查节点状态、代理链与凭据。"
  if (code === "bad_pid") return "进程不存在或已退出。"
  return ""
}

export function ProcessesTab({ nodeId, tabId, active }: Props) {
  const [sort, setSort] = React.useState<ProcSort>("cpu")
  const [search, setSearch] = React.useState("")
  const [detailPid, setDetailPid] = React.useState<number | null>(null)
  const { confirm, dialog } = useConfirm()

  // Live process list over SSE — the remote `ps` is re-run server-side every
  // few seconds and pushed, so the table updates without per-tick request setup
  // and the UI never blocks on a round-trip. Changing the sort re-subscribes.
  const streamUrl = React.useMemo(() => processStreamURL(nodeId, sort), [nodeId, sort])
  const { data, status, error } = useSseSnapshot<ProcessList>(streamUrl, { enabled: active })

  const signal = useMutation({
    mutationFn: ({ pid, sig }: { pid: number; sig: ProcSignal }) => processService.signal(nodeId, pid, sig),
    onSuccess: (_d, v) => toast.success(`已发送 ${v.sig} 至 #${v.pid}`),
    onError: (e: ApiError) => toast.error("发送信号失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })
  const renice = useMutation({
    mutationFn: ({ pid, nice }: { pid: number; nice: number }) => processService.renice(nodeId, pid, nice),
    onSuccess: (_d, v) => toast.success(`#${v.pid} 优先级 → ${v.nice}`),
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
    const all = data?.processes ?? []
    const q = search.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (p) => p.comm.toLowerCase().includes(q) || p.args.toLowerCase().includes(q) || p.user.toLowerCase().includes(q) || String(p.pid).includes(q),
    )
  }, [data, search])

  if (!active) return null

  if (status === "error" && !data) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Gauge className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法读取进程</div>
        <div className="text-xs">{error}</div>
        {errorHint(undefined, error || "") && <div className="text-xs text-foreground/80">{errorHint(undefined, error || "")}</div>}
      </div>
    )
  }

  const busy = signal.isPending || renice.isPending

  return (
    <div className="flex h-full min-h-0 flex-col">
      {dialog}

      {/* In-place live telemetry — CPU/mem/load/disk mini-charts over the same node. */}
      <div className="border-b px-2 pb-1.5 pt-2">
        <LiveKpiStrip nodeId={nodeId} active={active} />
      </div>

      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
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
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="过滤 pid/命令/用户…" className="h-7 pl-7 text-xs" />
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px]">{data?.total ?? rows.length}</Badge>
        <LiveDot status={status} />
      </div>

      <div className="min-h-0 flex-1">
        {!data && status !== "error" ? (
          <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> 加载进程…
          </div>
        ) : (
          <VirtualTable<ProcRow>
            rows={rows}
            empty="无匹配进程"
            header={<ProcHeader />}
            renderRow={(p) => (
              <ProcRowCells
                p={p}
                tabId={tabId}
                busy={busy}
                onSignal={(sig) => onSignal(p.pid, sig, p.comm)}
                onRenice={(nice) => renice.mutate({ pid: p.pid, nice })}
                onDetail={() => setDetailPid(p.pid)}
              />
            )}
          />
        )}
      </div>

      <DetailSheet nodeId={nodeId} pid={detailPid} onClose={() => setDetailPid(null)} />
    </div>
  )
}

// Pulsing live indicator — replaces the old manual refresh button now that the
// stream pushes updates on its own.
function LiveDot({ status }: { status: string }) {
  const live = status === "live"
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
      title={live ? "实时推送中" : status === "error" ? "连接中断" : "连接中…"}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", live ? "bg-success" : status === "error" ? "bg-destructive" : "bg-warning")} />
        {live && <span className="absolute inset-0 animate-ping rounded-full bg-success" />}
      </span>
      实时
    </span>
  )
}

function ProcHeader() {
  return (
    <>
      <th className="w-14 px-2 py-1.5 text-left">PID</th>
      <th className="w-16 px-2 py-1.5 text-left">用户</th>
      <th className="w-12 px-2 py-1.5 text-right">CPU</th>
      <th className="w-12 px-2 py-1.5 text-right">内存</th>
      <th className="px-2 py-1.5 text-left">命令</th>
      <th className="w-16 px-2 py-1.5 text-right"></th>
    </>
  )
}

function ProcRowCells({
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
    <>
      <td className="px-2 py-1 font-mono tabular-nums">{p.pid}</td>
      <td className="max-w-[5rem] truncate px-2 py-1" title={p.user}>{p.user}</td>
      <td className={cn("px-2 py-1 text-right tabular-nums", usagePctTone(p.cpu_pct))}>{p.cpu_pct.toFixed(1)}</td>
      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{p.mem_pct.toFixed(1)}</td>
      <td className="min-w-0 px-2 py-1">
        <button type="button" onClick={onDetail} className="block max-w-[14rem] truncate text-left font-mono hover:text-primary" title={p.args || p.comm}>
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
    </>
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
      <PopoverContent align="end" className="w-56 space-y-2 p-3">
        <div className="text-xs font-medium">调整优先级 (nice)</div>
        <div className="flex items-center gap-2">
          <input type="range" min={-20} max={19} value={val} onChange={(e) => setVal(Number(e.target.value))} className="flex-1 accent-[#cc785c]" />
          <span className="w-8 text-right text-xs tabular-nums">{val}</span>
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
      <SheetContent side="right" className="flex w-[min(560px,calc(100vw-2rem))] flex-col gap-3 sm:max-w-none">
        <SheetHeader>
          <SheetTitle>进程 #{pid}</SheetTitle>
          <SheetDescription className="truncate" title={d?.cmdline || ""}>{d?.status?.Name || "进程详情"}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-1">
          {detail.isLoading && <div className="inline-flex items-center gap-2 py-4 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载…</div>}
          {detail.isError && <div className="py-2 text-xs text-destructive">{(detail.error as ApiError)?.message}</div>}
          {d && (
            <>
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-[11px]">
                {Object.entries(d.status).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="truncate font-mono" title={v}>{v}</dd>
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
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">命令行</div>
                  <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px]">{d.cmdline}</pre>
                </div>
              )}
              {d.limits && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">资源限制</div>
                  <pre className="max-h-48 overflow-x-auto whitespace-pre rounded-md bg-muted/60 p-2 font-mono text-[10px]">{d.limits}</pre>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
