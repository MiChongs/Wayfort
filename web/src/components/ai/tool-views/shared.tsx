"use client"

import * as React from "react"
import {
  FileText,
  FileArchive,
  FileCode,
  FileImage,
  Folder,
} from "lucide-react"
import { VirtualTable } from "@/components/common/virtual-table"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

// Above this row count a family table virtualises (bounded-height + Virtuoso);
// below it we keep a plain table so short results animate in and need no scroll.
export const VIRTUALIZE_ROWS = 30

export type Tone = "success" | "warning" | "error" | "muted" | "info"

const toneDot: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/50",
  info: "bg-primary",
}

const toneText: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
  muted: "text-muted-foreground",
  info: "text-primary",
}

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span
      className={cn("inline-block size-1.5 shrink-0 rounded-full", toneDot[tone], className)}
      aria-hidden
    />
  )
}

export function ToneText({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={toneText[tone]}>{children}</span>
}

// Meter — a thin capacity/usage bar. Crosses to warning/error tones past the
// given thresholds. Depth comes from a hairline track + filled bar, no shadow.
export function Meter({
  value,
  max = 100,
  warnAt = 80,
  dangerAt = 92,
  className,
  label,
}: {
  value: number
  max?: number
  warnAt?: number
  dangerAt?: number
  className?: string
  label?: string
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  const fill =
    pct >= dangerAt ? "bg-destructive" : pct >= warnAt ? "bg-warning" : "bg-primary/60"
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-border/60">
        <div className={cn("h-full rounded-full transition-[width]", fill)} style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {label ?? `${pct.toFixed(0)}%`}
      </span>
    </div>
  )
}

// ViewShell — the standard humanised result-card frame: an eyebrow title, an
// optional count chip, optional toolbar, and the content. Matches the quiet
// ToolCard container language (hairline border + card surface, no shadow).
export function ViewShell({
  title,
  count,
  actions,
  children,
  className,
}: {
  title: string
  count?: number | string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border/60 bg-card", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {count !== undefined && (
          <span className="rounded-full bg-muted px-1.5 py-px font-mono text-[10px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

export interface Column<T> {
  key: string
  header: React.ReactNode
  render: (row: T, index: number) => React.ReactNode
  className?: string
  align?: "left" | "right" | "center"
  /** Sticky header click handler (for sortable columns). */
  onSort?: () => void
  sortDir?: "asc" | "desc" | null
}

const alignCls = (a?: "left" | "right" | "center") =>
  a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left"

// AutoTable renders columns either as a static table (short lists) or a
// virtualised one (long lists), keeping the header sticky in both. Bounded
// height is applied only when virtualising so short cards stay compact.
export function AutoTable<T>({
  rows,
  columns,
  empty = "无数据",
  height = "min(60vh,28rem)",
}: {
  rows: T[]
  columns: Column<T>[]
  empty?: React.ReactNode
  height?: string
}) {
  if (!rows || rows.length === 0) {
    return <div className="px-3 py-4 text-center text-xs text-muted-foreground">{empty}</div>
  }

  if (rows.length > VIRTUALIZE_ROWS) {
    return (
      <div style={{ height }}>
        <VirtualTable
          rows={rows}
          header={columns.map((c) => (
            <th
              key={c.key}
              className={cn("px-2 py-1.5 font-medium", alignCls(c.align), c.className)}
            >
              {c.header}
            </th>
          ))}
          renderRow={(row, i) =>
            columns.map((c) => (
              <td key={c.key} className={cn("px-2 py-1 align-top", alignCls(c.align), c.className)}>
                {c.render(row, i)}
              </td>
            ))
          }
        />
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c) => (
            <TableHead
              key={c.key}
              className={cn(
                "h-7 px-2 text-[10px] uppercase",
                alignCls(c.align),
                c.onSort && "cursor-pointer select-none hover:text-foreground",
                c.className,
              )}
              onClick={c.onSort}
            >
              <span className="inline-flex items-center gap-1">
                {c.header}
                {c.sortDir === "asc" && <span aria-hidden>↑</span>}
                {c.sortDir === "desc" && <span aria-hidden>↓</span>}
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            {columns.map((c) => (
              <TableCell
                key={c.key}
                className={cn("px-2 py-1 align-top text-xs", alignCls(c.align), c.className)}
              >
                {c.render(row, i)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// KeyValue renders an object as a compact definition list (BIOS / hardware /
// single-record details). Nested objects/arrays are JSON-stringified.
export function KeyValue({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "")
  if (entries.length === 0) {
    return <div className="px-3 py-4 text-center text-xs text-muted-foreground">无数据</div>
  }
  return (
    <dl className="divide-y divide-border/50">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-3 px-3 py-1.5">
          <dt className="w-40 shrink-0 truncate text-[11px] text-muted-foreground" title={k}>
            {k}
          </dt>
          <dd className="min-w-0 flex-1 break-words font-mono text-xs tabular-nums">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function MonoCell({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className="block max-w-[28rem] truncate font-mono text-[11px]" title={title}>
      {children}
    </span>
  )
}

export function pickFileIcon(name: string, isDir: boolean) {
  if (isDir) return <Folder className="size-3.5 shrink-0 text-primary/70" />
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext))
    return <FileImage className="size-3.5 shrink-0 text-muted-foreground" />
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(ext))
    return <FileArchive className="size-3.5 shrink-0 text-muted-foreground" />
  if (["js", "ts", "go", "py", "sh", "json", "yaml", "yml", "toml", "conf", "xml"].includes(ext))
    return <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
  return <FileText className="size-3.5 shrink-0 text-muted-foreground" />
}

// num coerces an unknown JSON value to a finite number (0 fallback).
export function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""))
  return Number.isFinite(n) ? n : 0
}

export function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v)
}
