"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

// Pretty-print a tool result. We try JSON first (most of our backend tools
// return JSON), fall back to a monospace block for plain text. Long output is
// collapsed by default; theme-aware backgrounds via design tokens.
export function ToolOutputView({ raw, danger }: { raw: string; danger?: boolean }) {
  const parsed = React.useMemo(() => {
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed)
      } catch {
        /* */
      }
    }
    return null
  }, [raw])

  const reduce = useReducedMotion()
  const [expanded, setExpanded] = React.useState(false)
  const longText = raw.length > 1200

  if (parsed && typeof parsed === "object" && parsed !== null) {
    return <JsonValue value={parsed} />
  }

  return (
    <div
      className={cn(
        "rounded-md text-xs font-mono whitespace-pre-wrap break-words border",
        danger ? "bg-zinc-900 text-zinc-50 border-zinc-700" : "bg-muted text-foreground border-border/60",
        "p-3 overflow-auto max-h-[24rem]",
      )}
    >
      {longText && !expanded ? (
        <>
          {raw.slice(0, 1200)}
          <button
            onClick={() => setExpanded(true)}
            className="block mt-2 text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
          >
            <ChevronDown className="inline w-3 h-3 mr-1" /> 展开剩余 {raw.length - 1200} 字符
          </button>
        </>
      ) : (
        <AnimatePresence mode="wait">
          <motion.span
            key={expanded ? "full" : "preview"}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduce ? { duration: 0 } : { duration: 0.18 }}
          >
            {raw}
          </motion.span>
        </AnimatePresence>
      )}
    </div>
  )
}

function JsonValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <JsonArray rows={value} />
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>
    if (Array.isArray(v.nodes)) return <NodeTable nodes={v.nodes as Record<string, unknown>[]} />
    if (Array.isArray(v.sessions)) return <Pre value={v} />
    if (Array.isArray(v.entries))
      return (
        <FileTable
          entries={v.entries as Record<string, unknown>[]}
          pathLabel={String(v.path || "")}
        />
      )
  }
  return <Pre value={value} />
}

function Pre({ value }: { value: unknown }) {
  const reduce = useReducedMotion()
  const [open, setOpen] = React.useState(false)
  const text = JSON.stringify(value, null, 2)
  const isLong = text.length > 600
  return (
    <div className="rounded-md bg-muted text-foreground p-3 text-xs whitespace-pre-wrap overflow-auto max-h-[24rem] border border-border/60">
      <pre className="font-mono">
        {isLong && !open ? text.slice(0, 600) + "…" : text}
      </pre>
      {isLong && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-2 inline-flex items-center text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
        >
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduce ? { duration: 0 } : { duration: 0.18 }}
          >
            <ChevronRight className="inline w-3 h-3 mr-1" />
          </motion.span>
          {open ? "收起" : "展开"}
        </button>
      )}
    </div>
  )
}

function JsonArray({ rows }: { rows: unknown[] }) {
  if (rows.length === 0)
    return <div className="text-xs text-muted-foreground">空数组</div>
  return <Pre value={rows} />
}

function NodeTable({ nodes }: { nodes: Record<string, unknown>[] }) {
  if (nodes.length === 0)
    return <div className="text-xs text-muted-foreground">没有节点</div>
  return (
    <div className="rounded-md border border-border/60 overflow-x-auto bg-card">
      <table className="w-full text-xs">
        <thead className="bg-muted">
          <tr>
            <th className="text-left px-2 py-1.5 font-medium">ID</th>
            <th className="text-left px-2 py-1.5 font-medium">名称</th>
            <th className="text-left px-2 py-1.5 font-medium">协议</th>
            <th className="text-left px-2 py-1.5 font-medium">地址</th>
          </tr>
        </thead>
        <tbody>
          {nodes.slice(0, 100).map((n, i) => (
            <tr key={i} className="border-t border-border/40 hover:bg-muted/40">
              <td className="px-2 py-1 font-mono">{String(n.id ?? "")}</td>
              <td className="px-2 py-1">{String(n.name ?? "")}</td>
              <td className="px-2 py-1">{String(n.protocol ?? "")}</td>
              <td className="px-2 py-1 font-mono">
                {String(n.host ?? "")}:{String(n.port ?? "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {nodes.length > 100 && (
        <div className="px-2 py-1 text-[10px] text-muted-foreground">
          仅显示前 100 条…
        </div>
      )}
    </div>
  )
}

function FileTable({
  entries,
  pathLabel,
}: {
  entries: Record<string, unknown>[]
  pathLabel: string
}) {
  return (
    <div>
      {pathLabel && (
        <div className="text-xs text-muted-foreground mb-1 font-mono">
          {pathLabel}
        </div>
      )}
      <div className="rounded-md border border-border/60 overflow-x-auto bg-card">
        <table className="w-full text-xs">
          <thead className="bg-muted">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">名称</th>
              <th className="text-left px-2 py-1.5 font-medium">大小</th>
              <th className="text-left px-2 py-1.5 font-medium">权限</th>
              <th className="text-left px-2 py-1.5 font-medium">修改时间</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 50).map((e, i) => (
              <tr key={i} className="border-t border-border/40 hover:bg-muted/40">
                <td className="px-2 py-1">
                  {Boolean(e.is_dir) ? "📁 " : "📄 "}
                  {String(e.name ?? "")}
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  {Number(e.size || 0)}
                </td>
                <td className="px-2 py-1 font-mono text-muted-foreground">
                  {String(e.mode ?? "")}
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {String(e.mod_time ?? "").slice(0, 19)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length > 50 && (
          <div className="px-2 py-1 text-[10px] text-muted-foreground">
            仅显示前 50 条…
          </div>
        )}
      </div>
    </div>
  )
}
