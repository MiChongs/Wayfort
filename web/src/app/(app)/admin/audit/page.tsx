"use client"

import * as React from "react"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Lock,
  Radio,
  RefreshCw,
  ScrollText,
  Search,
  X,
} from "lucide-react"
import { streamSSE } from "@/lib/sse/eventsource"
import { auditService } from "@/lib/api/services"
import type { AuditLogRow, AuditQuery } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { VirtualTable } from "@/components/common/virtual-table"
import { EmptyState } from "@/components/common/empty-state"
import { DatePicker } from "@/components/ui/date-picker"
import { useAccess } from "@/lib/hooks/use-access"
import { fullTime, relTime } from "@/lib/format"
import {
  auditMeta, categoryMeta, auditSeverity, AUDIT_CATEGORIES,
} from "@/lib/session-meta"
import { cn } from "@/lib/utils"
import { AuditOverview } from "./components/audit-overview"
import { AuditIntegrityPanel } from "./components/audit-integrity-panel"
import { AuditDetailDrawer } from "./components/audit-detail-drawer"

const PAGE_SIZE = 50

type ChipType = "user" | "ip" | "node" | "kind"
interface Chip { type: ChipType; value: string; label: string }

const CHIP_LABEL: Record<ChipType, string> = {
  user: "用户", ip: "来源 IP", node: "资产", kind: "事件",
}

const RANGES = [
  { key: "all", label: "全部时间" },
  { key: "today", label: "今天" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "custom", label: "自定义…" },
]

function startOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }
function endOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999) }

export default function AuditPage() {
  const access = useAccess()
  const canRead = access.isSuperadmin || access.permissions.includes("audit:read")

  const [category, setCategory] = React.useState("")
  const [onlyAbnormal, setOnlyAbnormal] = React.useState(false)
  const [live, setLive] = React.useState(false)
  const [q, setQ] = React.useState("")
  const [dq, setDq] = React.useState("")
  const [range, setRange] = React.useState("all")
  const [customFrom, setCustomFrom] = React.useState<Date | undefined>()
  const [customTo, setCustomTo] = React.useState<Date | undefined>()
  const [chips, setChips] = React.useState<Chip[]>([])
  const [page, setPage] = React.useState(0)
  const [selected, setSelected] = React.useState<AuditLogRow | null>(null)

  React.useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  // Any filter change returns to page 1.
  React.useEffect(() => { setPage(0) }, [category, onlyAbnormal, dq, range, customFrom, customTo, chips])

  const addChip = React.useCallback((type: ChipType, value: string, label?: string) => {
    if (!value) return
    setChips((prev) => [...prev.filter((c) => c.type !== type), { type, value, label: label ?? value }])
  }, [])
  const removeChip = (type: ChipType) => setChips((prev) => prev.filter((c) => c.type !== type))
  const clearChips = () => setChips([])

  const timeBounds = React.useMemo<{ from?: string; to?: string }>(() => {
    const now = new Date()
    if (range === "today") return { from: startOfDay(now).toISOString() }
    if (range === "7d") return { from: new Date(now.getTime() - 7 * 86400_000).toISOString() }
    if (range === "30d") return { from: new Date(now.getTime() - 30 * 86400_000).toISOString() }
    if (range === "custom") {
      return {
        from: customFrom ? startOfDay(customFrom).toISOString() : undefined,
        to: customTo ? endOfDay(customTo).toISOString() : undefined,
      }
    }
    return {}
  }, [range, customFrom, customTo])

  // The shared filter — without pagination — drives the list, the stream, and
  // the export so all three scope identically.
  const baseQuery = React.useMemo<AuditQuery>(() => {
    const byType = (t: ChipType) => chips.find((c) => c.type === t)?.value
    return {
      category: category || undefined,
      only_abnormal: onlyAbnormal || undefined,
      q: dq || undefined,
      username: byType("user"),
      client_ip: byType("ip"),
      node_name: byType("node"),
      kind: byType("kind"),
      from: timeBounds.from,
      to: timeBounds.to,
    }
  }, [category, onlyAbnormal, dq, chips, timeBounds])

  const listQuery = React.useMemo<AuditQuery>(
    () => ({ ...baseQuery, limit: PAGE_SIZE, offset: (live ? 0 : page) * PAGE_SIZE }),
    [baseQuery, page, live],
  )

  const list = useQuery({
    queryKey: ["audit-logs", listQuery],
    queryFn: () => auditService.list(listQuery),
    enabled: canRead,
    placeholderData: keepPreviousData,
  })

  const stats = useQuery({
    queryKey: ["audit-logs", "stats"],
    queryFn: () => auditService.stats(14),
    enabled: canRead,
    refetchInterval: live ? 20_000 : false,
  })

  const tail = useAuditTail(baseQuery, canRead && live)

  const baseRows = list.data?.audit_logs ?? []
  const rows = React.useMemo(() => {
    if (!live || tail.rows.length === 0) return baseRows
    const seen = new Set<number>()
    const merged: AuditLogRow[] = []
    for (const r of [...tail.rows, ...baseRows]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      merged.push(r)
    }
    return merged
  }, [live, tail.rows, baseRows])

  const total = list.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const exportHref = auditService.exportURL(baseQuery)

  if (!access.loading && !canRead) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState
          icon={Lock}
          title="需要审计读取权限"
          description="审计日志仅对持有 audit:read 权限的角色（如审计员、超级管理员）开放。"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
            <ScrollText className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">审计日志</h1>
            <p className="text-sm text-muted-foreground">每一次接入与操作都在此留痕，可追溯、可导出。</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={exportHref}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-accent"
          >
            <Download className="h-4 w-4" /> 导出 CSV
          </a>
          <Button variant="ghost" size="sm" onClick={() => { list.refetch(); stats.refetch() }}>
            <RefreshCw className={cn("h-4 w-4", list.isFetching && "animate-spin")} /> 刷新
          </Button>
        </div>
      </header>

      <AuditOverview
        stats={stats.data}
        loading={stats.isLoading}
        onlyAbnormal={onlyAbnormal}
        activeCategory={category}
        onPickCategory={(c) => setCategory(c)}
        onToggleAbnormal={() => setOnlyAbnormal((v) => !v)}
        onResetToTotal={() => { setCategory(""); setOnlyAbnormal(false); clearChips() }}
        onPickUser={(v) => addChip("user", v)}
        onPickNode={(v) => addChip("node", v)}
        onPickIp={(v) => addChip("ip", v)}
      />

      <AuditIntegrityPanel />

      {/* Toolbar */}
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* Category segmented (scrolls on narrow screens) */}
          <div className="no-scrollbar -mx-1 max-w-full overflow-x-auto px-1">
            <div className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5">
              <SegBtn active={!category} onClick={() => setCategory("")}>全部</SegBtn>
              {AUDIT_CATEGORIES.map((c) => {
                const m = categoryMeta(c)
                return (
                  <SegBtn key={c} active={category === c} onClick={() => setCategory(category === c ? "" : c)}>
                    {m.label}
                  </SegBtn>
                )
              })}
            </div>
          </div>

          <div className="relative w-60 max-w-full">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索用户 / IP / 详情…"
              className="pl-8"
            />
          </div>

          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>

          {range === "custom" && (
            <div className="flex items-center gap-1.5">
              <DatePicker value={customFrom} onChange={setCustomFrom} placeholder="起" className="w-32" />
              <span className="text-xs text-muted-foreground">至</span>
              <DatePicker value={customTo} onChange={setCustomTo} placeholder="止" className="w-32" />
            </div>
          )}

          <ToggleChip active={onlyAbnormal} onClick={() => setOnlyAbnormal((v) => !v)} tone="danger">
            <AlertTriangle className="h-3.5 w-3.5" /> 仅异常
          </ToggleChip>
          <ToggleChip active={live} onClick={() => setLive((v) => !v)} tone="live">
            <span className="relative flex h-2 w-2">
              {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />}
              <span className={cn("relative inline-flex h-2 w-2 rounded-full", live ? "bg-success" : "bg-muted-foreground/40")} />
            </span>
            实时
          </ToggleChip>

          <div className="ml-auto text-xs text-muted-foreground tabular-nums">
            共 {total.toLocaleString()} 条
          </div>
        </div>

        {/* Active facet chips */}
        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <span
                key={chip.type}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-1 text-xs text-primary"
              >
                <span className="text-primary/70">{CHIP_LABEL[chip.type]}:</span>
                <span className="max-w-[160px] truncate font-medium">{chip.label}</span>
                <button type="button" onClick={() => removeChip(chip.type)} className="rounded-full p-0.5 hover:bg-primary/20">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button type="button" onClick={clearChips} className="text-xs text-muted-foreground hover:text-foreground">
              清空
            </button>
          </div>
        )}
      </div>

      {/* Event stream — fixed, viewport-relative height so the virtual list keeps
          a bounded scroller while the page itself scrolls naturally. */}
      <div className="flex h-[clamp(420px,60vh,720px)] flex-col overflow-hidden rounded-xl border bg-card">
        {live && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-success/[0.04] px-4 py-1.5 text-xs text-muted-foreground">
            <Radio className="h-3.5 w-3.5 text-success" />
            {tail.status === "live" ? "实时追踪中" : tail.status === "connecting" ? "连接中…" : tail.status === "error" ? "连接中断，正在重试…" : "等待事件…"}
            {tail.rows.length > 0 && <span className="tabular-nums">· 本次已涌入 {tail.rows.length} 条</span>}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {list.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-9 animate-pulse rounded-md bg-muted/50" />
              ))}
            </div>
          ) : (
            <VirtualTable
              rows={rows}
              header={<AuditHeader />}
              renderRow={(row) => (
                <AuditRowCells
                  row={row}
                  isNew={live && tail.rows.some((r) => r.id === row.id)}
                  onOpen={() => setSelected(row)}
                  onPick={addChip}
                />
              )}
              empty={
                <EmptyState
                  icon={onlyAbnormal ? AlertTriangle : ScrollText}
                  title={hasFilters(baseQuery) ? "没有匹配的审计事件" : "暂无审计事件"}
                  description={
                    hasFilters(baseQuery)
                      ? "换个关键词、放宽时间范围，或清空筛选条件试试。"
                      : "系统运行后，登录、命令、文件与运维动作都会实时出现在这里。"
                  }
                />
              }
            />
          )}
        </div>

        {/* Footer: pagination (hidden while live) */}
        {!live && total > PAGE_SIZE && (
          <div className="flex shrink-0 items-center justify-end gap-3 border-t px-4 py-2 text-xs">
            <span className="text-muted-foreground">第 {page + 1} / {pages} 页</span>
            <Button variant="outline" size="xs" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft className="h-3.5 w-3.5" /> 上一页
            </Button>
            <Button variant="outline" size="xs" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              下一页 <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <AuditDetailDrawer
        row={selected}
        onClose={() => setSelected(null)}
        onPickUser={(v) => { addChip("user", v); setSelected(null) }}
        onPickNode={(v) => { addChip("node", v); setSelected(null) }}
        onPickIp={(v) => { addChip("ip", v); setSelected(null) }}
      />
    </div>
  )
}

// ----- live tail hook -----

type TailStatus = "idle" | "connecting" | "live" | "error"

function useAuditTail(query: AuditQuery, enabled: boolean) {
  const [rows, setRows] = React.useState<AuditLogRow[]>([])
  const [status, setStatus] = React.useState<TailStatus>("idle")
  const key = JSON.stringify(query)

  React.useEffect(() => {
    if (!enabled) { setStatus("idle"); setRows([]); return }
    setRows([])
    const url = auditService.streamURL(query)
    let stopped = false
    const ctrl = new AbortController()
    let attempt = 0
    let timer: number | null = null

    const connect = async () => {
      if (stopped) return
      setStatus((s) => (s === "live" ? s : "connecting"))
      try {
        await streamSSE(url, { signal: ctrl.signal }, (kind, payload) => {
          if (stopped) return
          if (kind === "ready") {
            setStatus("live")
          } else if (kind === "append") {
            setStatus("live")
            const row = payload as AuditLogRow
            setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev].slice(0, 500)))
            attempt = 0
          }
        })
      } catch {
        if (stopped || ctrl.signal.aborted) return
        setStatus("error")
      }
      if (stopped || ctrl.signal.aborted) return
      const delay = Math.min(1000 * 2 ** attempt, 15000)
      attempt += 1
      timer = window.setTimeout(connect, delay)
    }

    void connect()
    return () => { stopped = true; ctrl.abort(); if (timer) window.clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  return { rows, status }
}

// ----- table cells -----

function AuditHeader() {
  return (
    <>
      <th className="px-3 py-2 text-left font-medium">时间</th>
      <th className="px-3 py-2 text-left font-medium">用户</th>
      <th className="px-3 py-2 text-left font-medium">类别</th>
      <th className="hidden px-3 py-2 text-left font-medium md:table-cell">目标</th>
      <th className="hidden px-3 py-2 text-left font-medium lg:table-cell">来源</th>
      <th className="hidden px-3 py-2 text-left font-medium md:table-cell">摘要</th>
      <th className="w-8 px-2 py-2" />
    </>
  )
}

function AuditRowCells({
  row, isNew, onOpen, onPick,
}: {
  row: AuditLogRow
  isNew?: boolean
  onOpen: () => void
  onPick: (type: ChipType, value: string, label?: string) => void
}) {
  const meta = auditMeta(row.kind)
  const Icon = meta.icon
  const sev = auditSeverity(row)
  const cell = "px-3 py-2 align-middle cursor-pointer"
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  const summary = row.payload ? (row.payload.length > 160 ? row.payload.slice(0, 160) + "…" : row.payload) : "—"

  return (
    <>
      <td className={cn(cell, "relative whitespace-nowrap", isNew && "bg-primary/[0.05]")} onClick={onOpen}>
        <span
          className={cn(
            "absolute inset-y-0 left-0 w-[2px]",
            sev === "danger" ? "bg-destructive" : sev === "warn" ? "bg-warning/80" : "bg-transparent",
          )}
        />
        <span className="block text-foreground">{relTime(row.created_at)}</span>
        <span className="block text-[10px] text-muted-foreground">{fullTime(row.created_at).slice(5)}</span>
      </td>

      <td className={cell} onClick={onOpen}>
        <button
          type="button"
          onClick={stop(() => onPick("user", row.username))}
          className="flex items-center gap-1.5 hover:text-primary"
          title="按此用户筛选"
        >
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-muted text-[9px] font-medium uppercase text-muted-foreground">
            {(row.username || "?").slice(0, 1)}
          </span>
          <span className="max-w-[96px] truncate">{row.username || "—"}</span>
        </button>
      </td>

      <td className={cell} onClick={onOpen}>
        <button type="button" onClick={stop(() => onPick("kind", row.kind, meta.label))} title="按此事件筛选">
          <Badge variant={meta.tone} className="gap-1 font-normal">
            <Icon className="h-3 w-3" /> {meta.label}
          </Badge>
        </button>
      </td>

      <td className={cn(cell, "hidden md:table-cell")} onClick={onOpen}>
        {row.node_name ? (
          <button type="button" onClick={stop(() => onPick("node", row.node_name!))} className="max-w-[140px] truncate hover:text-primary" title="按此资产筛选">
            {row.node_name}
          </button>
        ) : row.session_id ? (
          <span className="font-mono text-[10px] text-muted-foreground">{row.session_id.slice(0, 10)}…</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>

      <td className={cn(cell, "hidden lg:table-cell")} onClick={onOpen}>
        {row.client_ip ? (
          <button type="button" onClick={stop(() => onPick("ip", row.client_ip!))} className="font-mono text-[10px] text-muted-foreground hover:text-primary" title="按此 IP 筛选">
            {row.client_ip}
          </button>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>

      <td className={cn(cell, "hidden md:table-cell")} onClick={onOpen}>
        <span className={cn(
          "block max-w-[360px] truncate",
          sev === "danger" && row.kind === "command" ? "font-mono text-destructive" : "text-muted-foreground",
        )} title={row.payload || ""}>
          {summary}
        </span>
      </td>

      <td className="w-8 px-2 py-2 text-right" onClick={onOpen}>
        <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
      </td>
    </>
  )
}

// ----- small controls -----

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function ToggleChip({
  active, onClick, tone, children,
}: {
  active: boolean
  onClick: () => void
  tone: "danger" | "live"
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
        !active && "text-muted-foreground hover:bg-accent",
        active && tone === "danger" && "border-destructive/40 bg-destructive/[0.06] text-destructive",
        active && tone === "live" && "border-success/40 bg-success/[0.06] text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function hasFilters(q: AuditQuery): boolean {
  return !!(q.category || q.only_abnormal || q.q || q.username || q.client_ip || q.node_name || q.kind || q.from || q.to)
}
