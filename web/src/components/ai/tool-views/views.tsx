"use client"

import * as React from "react"
import { Virtuoso } from "react-virtuoso"
import { fmtBytes, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  AutoTable,
  type Column,
  KeyValue,
  Meter,
  MonoCell,
  StatusDot,
  type Tone,
  ViewShell,
  num,
  pickFileIcon,
  str,
} from "./shared"

type Data = unknown
type Obj = Record<string, unknown>

// ============================================================================
// Registry — view name (backend `_view`) → renderer. Unknown views fall back
// to the generic AutoView, so every tool result renders something sensible.
// ============================================================================
const REGISTRY: Record<string, React.FC<{ data: Data }>> = {
  db_result: DbResultGrid,
  log: LogView,
  metrics: MetricsView,
  oss_objects: OssObjectsView,
  oss_buckets: OssBucketsView,
  knowledge_search: KnowledgeSearchView,
}

export function pickToolView(view?: string): React.FC<{ data: Data }> | null {
  if (!view) return null
  return REGISTRY[view] ?? AutoView
}

// ============================================================================
// knowledge_search — RAG retrieval hits: source doc + similarity + chunk text.
// ============================================================================
function KnowledgeSearchView({ data }: { data: Data }) {
  const d = (data ?? {}) as { query?: string; hits?: Obj[] }
  const hits = d.hits ?? []
  return (
    <ViewShell title={d.query ? `检索：${str(d.query)}` : "知识检索"} count={hits.length}>
      {hits.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">无匹配片段</div>
      ) : (
        <div className="divide-y divide-border/50">
          {hits.map((h, i) => {
            const score = Math.max(0, Math.min(1, num(h.score)))
            const match = str(h.match)
            const matchLabel = match === "hybrid" ? "语义+关键词" : match === "keyword" ? "关键词" : match === "vector" ? "语义" : ""
            return (
              <div key={i} className="space-y-1 px-3 py-2">
                <div className="flex items-center gap-2">
                  <MonoCell>{str(h.document) || `#${str(h.document_id)}`}</MonoCell>
                  {h.knowledge_base ? (
                    <span className="text-[10px] text-muted-foreground">{str(h.knowledge_base)}</span>
                  ) : null}
                  {matchLabel && (
                    <span className="rounded border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground">
                      {matchLabel}
                    </span>
                  )}
                  {/* keyword-only hits carry no cosine score — a 0% meter would mislead */}
                  {score > 0 && (
                    <span className="ml-auto w-20 shrink-0">
                      <Meter value={score * 100} warnAt={101} dangerAt={101} label={`${(score * 100).toFixed(0)}%`} />
                    </span>
                  )}
                </div>
                <p className="line-clamp-6 whitespace-pre-wrap break-words text-xs text-foreground/80">
                  {str(h.text)}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </ViewShell>
  )
}

// ============================================================================
// Heuristics shared by the generic renderer
// ============================================================================
function statusTone(v: unknown): Tone {
  const s = String(v ?? "").toLowerCase()
  if (/(active|running|online|healthy|ok|up|success|enabled|allow|listen|loaded|ready)/.test(s)) return "success"
  if (/(fail|error|dead|down|offline|critical|crash|deny|reject|exited|oom)/.test(s)) return "error"
  if (/(warn|degrad|pending|paused|activating|deactivating|inactive|stopped|disabled|unknown)/.test(s)) return "warning"
  return "muted"
}

const prettyHeader = (k: string) =>
  k.replace(/_/g, " ").replace(/\bpct\b/i, "%").replace(/\bkb\b/i, "KB")

const isPctKey = (k: string) => /(pct|percent|usage|util)$/i.test(k) || /(_pct|percent)/i.test(k)
const isStatusKey = (k: string) => /(state|status|active|sub|health|phase|enabled|action)$/i.test(k) || /^(state|status|active|sub|health|enabled|action)$/i.test(k)
const isTimeKey = (k: string) => /(_at|_time|time|date|modified|created|started)$/i.test(k)
const isByteKey = (k: string) => /(bytes|_size|^size)$/i.test(k)
const isMonoKey = (k: string) => /(id|pid|key|name|host|addr|ip|path|sha|hash|uuid|image|ref|unit|cmd|command|version)/i.test(k)
const isNumericKey = (k: string) => isPctKey(k) || /(count|num|total|rss|mem|cpu|size|bytes|port|uid|gid|nice|pid|replicas|rows|affected)/i.test(k)

function renderCell(key: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground/40">—</span>
  if (typeof value === "boolean")
    return value ? <StatusDot tone="success" /> : <StatusDot tone="muted" />
  if (typeof value === "object") return <MonoCell title={JSON.stringify(value)}>{JSON.stringify(value)}</MonoCell>

  if (isPctKey(key) && typeof value === "number") return <Meter value={num(value)} />
  if (isStatusKey(key))
    return (
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone={statusTone(value)} />
        <span className="truncate">{str(value)}</span>
      </span>
    )
  if (isByteKey(key) && typeof value === "number") return <span className="tabular-nums">{fmtBytes(num(value))}</span>
  if (isTimeKey(key) && typeof value === "string") return <span className="text-muted-foreground">{relTime(value) || value}</span>
  if (isMonoKey(key)) return <MonoCell title={str(value)}>{str(value)}</MonoCell>
  if (typeof value === "number") return <span className="tabular-nums">{value}</span>
  return <span className="truncate" title={str(value)}>{str(value)}</span>
}

function deriveColumns(rows: Obj[]): Column<Obj>[] {
  const seen: string[] = []
  for (const r of rows.slice(0, 8)) {
    for (const k of Object.keys(r ?? {})) if (!seen.includes(k)) seen.push(k)
  }
  return seen.slice(0, 9).map((k) => ({
    key: k,
    header: prettyHeader(k),
    align: isNumericKey(k) ? "right" : "left",
    render: (row: Obj) => renderCell(k, row[k]),
  }))
}

// ============================================================================
// Generic AutoView — array → humanised table; object → sections / key-value
// ============================================================================
function ArrayView({ rows }: { rows: unknown[] }) {
  if (rows.length === 0) return <div className="px-3 py-4 text-center text-xs text-muted-foreground">空</div>
  if (typeof rows[0] !== "object" || rows[0] === null) {
    return (
      <div className="flex flex-wrap gap-1.5 p-3">
        {rows.map((r, i) => (
          <span key={i} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {str(r)}
          </span>
        ))}
      </div>
    )
  }
  const objRows = rows as Obj[]
  return <AutoTable rows={objRows} columns={deriveColumns(objRows)} />
}

function AutoView({ data }: { data: Data }) {
  if (data === null || data === undefined) return <Empty />
  if (Array.isArray(data)) {
    return (
      <ViewShell title="结果" count={data.length}>
        <ArrayView rows={data} />
      </ViewShell>
    )
  }
  if (typeof data !== "object") {
    return <PreText text={String(data)} />
  }
  const obj = data as Obj
  const arrayFields = Object.entries(obj).filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0)
  const scalarFields = Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v === null || typeof v !== "object"),
  )

  if (arrayFields.length === 0) {
    // Pure object → key-value, but lift nested objects into their own blocks.
    const nested = Object.entries(obj).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
    if (nested.length === 0) return <ViewShell title="详情"><KeyValue obj={obj} /></ViewShell>
    return (
      <div className="space-y-2">
        {Object.keys(scalarFields).length > 0 && (
          <ViewShell title="详情">
            <KeyValue obj={scalarFields} />
          </ViewShell>
        )}
        {nested.map(([k, v]) => (
          <ViewShell key={k} title={prettyHeader(k)}>
            <KeyValue obj={v as Obj} />
          </ViewShell>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {Object.keys(scalarFields).length > 0 && (
        <ViewShell title="概览">
          <KeyValue obj={scalarFields} />
        </ViewShell>
      )}
      {arrayFields.map(([k, v]) => (
        <ViewShell key={k} title={prettyHeader(k)} count={(v as unknown[]).length}>
          <ArrayView rows={v as unknown[]} />
        </ViewShell>
      ))}
    </div>
  )
}

function Empty() {
  return <div className="px-3 py-4 text-center text-xs text-muted-foreground">无数据</div>
}

// ============================================================================
// DbResultGrid — SQL result set: typed columns, NULL markers, elapsed/row count
// ============================================================================
function DbResultGrid({ data }: { data: Data }) {
  const d = (data ?? {}) as {
    columns?: { name: string; type?: string }[]
    rows?: unknown[][]
    truncated?: boolean
    elapsed?: number
    row_count?: number
    affected?: number
  }
  if (d.affected !== undefined && !d.columns) {
    return (
      <ViewShell title="执行结果">
        <KeyValue obj={{ 受影响行数: d.affected, 耗时: fmtNs(d.elapsed) }} />
      </ViewShell>
    )
  }
  const cols = d.columns ?? []
  const rows = d.rows ?? []
  const columns: Column<unknown[]>[] = cols.map((c, ci) => ({
    key: c.name + ci,
    align: "left",
    header: (
      <span className="inline-flex flex-col leading-tight">
        <span className="text-foreground">{c.name}</span>
        {c.type && <span className="text-[9px] font-normal lowercase text-muted-foreground/70">{c.type}</span>}
      </span>
    ),
    render: (row: unknown[]) => {
      const v = row[ci]
      if (v === null || v === undefined) return <span className="italic text-muted-foreground/50">NULL</span>
      const isNum = typeof v === "number"
      return (
        <span className={cn("block max-w-[22rem] truncate", isNum && "text-right tabular-nums")} title={str(v)}>
          {str(v)}
        </span>
      )
    },
    className: typeof rows[0]?.[ci] === "number" ? "text-right" : "",
  }))

  return (
    <ViewShell
      title="查询结果"
      count={`${d.row_count ?? rows.length} 行`}
      actions={
        <span className="font-mono text-[10px] text-muted-foreground">
          {fmtNs(d.elapsed)}
          {d.truncated && <span className="ml-1.5 text-warning">已截断</span>}
        </span>
      }
    >
      <div className="overflow-x-auto">
        <AutoTable rows={rows} columns={columns} empty="0 行" />
      </div>
    </ViewShell>
  )
}

function fmtNs(ns?: number): string {
  if (!ns || ns <= 0) return "0ms"
  const ms = ns / 1e6
  if (ms < 1) return `${(ns / 1e3).toFixed(0)}µs`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// ============================================================================
// LogView — monospace, line numbers, level highlight, virtualised when long
// ============================================================================
function LogView({ data }: { data: Data }) {
  const text =
    typeof data === "string"
      ? data
      : str((data as Obj)?.text ?? (data as Obj)?.output ?? (data as Obj)?.content ?? "")
  const meta = typeof data === "object" && data !== null ? (data as Obj) : {}
  const lines = React.useMemo(() => (text ? text.replace(/\n$/, "").split("\n") : []), [text])
  const [filter, setFilter] = React.useState("")
  const shown = React.useMemo(
    () => (filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines),
    [lines, filter],
  )

  if (lines.length === 0) return <Empty />

  const label = [meta.source, meta.ref, meta.unit].filter(Boolean).join(" · ")

  const body =
    shown.length > 200 ? (
      <div style={{ height: "min(60vh,28rem)" }}>
        <Virtuoso
          data={shown}
          className="no-scrollbar"
          itemContent={(i, line) => <LogLine n={i + 1} line={line} />}
        />
      </div>
    ) : (
      <div className="max-h-[28rem] overflow-auto">
        {shown.map((line, i) => (
          <LogLine key={i} n={i + 1} line={line} />
        ))}
      </div>
    )

  return (
    <ViewShell
      title={label || "日志"}
      count={`${lines.length} 行`}
      actions={
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤…"
          className="h-5 w-24 rounded border border-border/60 bg-background px-1.5 text-[10px] outline-none focus:border-primary/50"
        />
      }
    >
      <div className="bg-muted/40 font-mono text-[11px] leading-relaxed">{body}</div>
    </ViewShell>
  )
}

function LogLine({ n, line }: { n: number; line: string }) {
  const tone = /\b(error|fatal|panic|fail|critical|oom)\b/i.test(line)
    ? "text-destructive"
    : /\b(warn|warning)\b/i.test(line)
      ? "text-warning"
      : /\b(info|notice)\b/i.test(line)
        ? "text-muted-foreground"
        : "text-foreground"
  return (
    <div className="flex gap-2 px-3 hover:bg-accent/30">
      <span className="w-10 shrink-0 select-none text-right text-muted-foreground/40 tabular-nums">{n}</span>
      <span className={cn("whitespace-pre-wrap break-all", tone)}>{line || " "}</span>
    </div>
  )
}

// ============================================================================
// MetricsView — perf snapshot rendered as colour-block stat tiles, not raw nums
// ============================================================================
function MetricsView({ data }: { data: Data }) {
  if (!data || typeof data !== "object") return <AutoView data={data} />
  const obj = data as Obj
  const scalars = Object.entries(obj).filter(([, v]) => typeof v === "number" || typeof v === "string")
  const groups = Object.entries(obj).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v))
  const arrays = Object.entries(obj).filter(([, v]) => Array.isArray(v) && (v as unknown[]).length > 0)

  return (
    <div className="space-y-2">
      {scalars.length > 0 && (
        <ViewShell title="性能快照">
          <div className="grid grid-cols-2 gap-px bg-border/40 sm:grid-cols-3">
            {scalars.map(([k, v]) => (
              <MetricTile key={k} label={prettyHeader(k)} value={v} keyName={k} />
            ))}
          </div>
        </ViewShell>
      )}
      {groups.map(([k, v]) => (
        <ViewShell key={k} title={prettyHeader(k)}>
          <div className="grid grid-cols-2 gap-px bg-border/40 sm:grid-cols-3">
            {Object.entries(v as Obj).map(([kk, vv]) => (
              <MetricTile key={kk} label={prettyHeader(kk)} value={vv} keyName={kk} />
            ))}
          </div>
        </ViewShell>
      ))}
      {arrays.map(([k, v]) => (
        <ViewShell key={k} title={prettyHeader(k)} count={(v as unknown[]).length}>
          <ArrayView rows={v as unknown[]} />
        </ViewShell>
      ))}
    </div>
  )
}

function MetricTile({ label, value, keyName }: { label: string; value: unknown; keyName: string }) {
  const isPct = isPctKey(keyName) && typeof value === "number"
  return (
    <div className="bg-card px-3 py-2">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground" title={label}>
        {label}
      </div>
      {isPct ? (
        <div className="mt-1">
          <Meter value={num(value)} />
        </div>
      ) : (
        <div className="mt-0.5 truncate font-mono text-sm tabular-nums">
          {isByteKey(keyName) && typeof value === "number" ? fmtBytes(num(value)) : str(value)}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// OSS views — object browser & bucket list
// ============================================================================
function OssObjectsView({ data }: { data: Data }) {
  const d = (data ?? {}) as {
    bucket?: string
    prefix?: string
    entries?: Obj[]
    truncated?: boolean
  }
  const entries = d.entries ?? []
  const columns: Column<Obj>[] = [
    {
      key: "name",
      header: "名称",
      render: (e) => (
        <span className="inline-flex items-center gap-1.5">
          {pickFileIcon(str(e.name || e.key), Boolean(e.is_dir))}
          <span className="truncate" title={str(e.key)}>{str(e.name || e.key)}</span>
        </span>
      ),
    },
    { key: "size", header: "大小", align: "right", render: (e) => (e.is_dir ? "—" : <span className="tabular-nums">{fmtBytes(num(e.size))}</span>) },
    { key: "storage_class", header: "存储类", render: (e) => <span className="text-muted-foreground">{str(e.storage_class) || "—"}</span> },
    { key: "last_modified", header: "修改时间", render: (e) => <span className="text-muted-foreground">{relTime(str(e.last_modified)) || "—"}</span> },
  ]
  return (
    <ViewShell
      title={d.bucket ? `${d.bucket}/${d.prefix ?? ""}` : "对象"}
      count={entries.length}
      actions={d.truncated ? <span className="text-[10px] text-warning">更多…</span> : undefined}
    >
      <AutoTable rows={entries} columns={columns} empty="此前缀下无对象" />
    </ViewShell>
  )
}

function OssBucketsView({ data }: { data: Data }) {
  const buckets = (Array.isArray(data) ? data : []) as Obj[]
  const columns: Column<Obj>[] = [
    { key: "name", header: "桶名", render: (b) => <MonoCell>{str(b.name)}</MonoCell> },
    { key: "region", header: "区域", render: (b) => <span className="text-muted-foreground">{str(b.region) || "—"}</span> },
    { key: "creation_date", header: "创建时间", render: (b) => <span className="text-muted-foreground">{relTime(str(b.creation_date)) || "—"}</span> },
  ]
  return (
    <ViewShell title="存储桶" count={buckets.length}>
      <AutoTable rows={buckets} columns={columns} empty="无桶" />
    </ViewShell>
  )
}

// ============================================================================
// PreText — last-resort plain text
// ============================================================================
function PreText({ text }: { text: string }) {
  return (
    <pre className="max-h-[24rem] overflow-auto rounded-md border border-border/60 bg-muted p-3 text-xs whitespace-pre-wrap text-foreground">
      {text}
    </pre>
  )
}

