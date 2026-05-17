"use client"

import * as React from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

// Pretty-print a tool result. We try JSON first (most of our backend tools
// return JSON), fall back to a monospace block for plain text. The first
// chunk of the text is shown by default; the rest collapses.
export function ToolOutputView({ raw, danger }: { raw: string; danger?: boolean }) {
  const parsed = React.useMemo(() => {
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { return JSON.parse(trimmed) } catch { /* */ }
    }
    return null
  }, [raw])

  const [expanded, setExpanded] = React.useState(false)
  const longText = raw.length > 1200

  if (parsed && typeof parsed === "object" && parsed !== null) {
    return <JsonValue value={parsed} expanded={expanded} />
  }
  return (
    <div className={cn("rounded text-xs font-mono whitespace-pre-wrap break-words", danger ? "bg-zinc-900 text-zinc-100" : "bg-zinc-950 text-zinc-100", "p-3 overflow-auto")}>
      {longText && !expanded ? (
        <>
          {raw.slice(0, 1200)}
          <button onClick={() => setExpanded(true)} className="block mt-2 text-blue-400 hover:underline">
            <ChevronDown className="inline w-3 h-3 mr-1" /> 展开剩余 {raw.length - 1200} 字符
          </button>
        </>
      ) : raw}
    </div>
  )
}

function JsonValue({ value, expanded }: { value: unknown; expanded: boolean }) {
  // Special-case the most common backend shapes.
  if (Array.isArray(value)) {
    return <JsonArray rows={value} />
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>
    if (Array.isArray(v.nodes)) return <NodeTable nodes={v.nodes as Record<string, unknown>[]} />
    if (Array.isArray(v.sessions)) return <Pre value={v} />
    if (Array.isArray(v.entries)) return <FileTable entries={v.entries as Record<string, unknown>[]} pathLabel={String(v.path || "")} />
  }
  return <Pre value={value} expanded={expanded} />
}

function Pre({ value, expanded }: { value: unknown; expanded?: boolean }) {
  const [open, setOpen] = React.useState(!!expanded)
  const text = JSON.stringify(value, null, 2)
  const isLong = text.length > 600
  return (
    <pre className="rounded bg-zinc-950 text-zinc-100 p-3 text-xs whitespace-pre-wrap overflow-auto max-h-96">
      {isLong && !open ? text.slice(0, 600) + "…" : text}
      {isLong && (
        <button onClick={() => setOpen((v) => !v)} className="block mt-2 text-blue-400 hover:underline">
          {open ? <ChevronDown className="inline w-3 h-3" /> : <ChevronRight className="inline w-3 h-3" />}
          {open ? " 收起" : " 展开"}
        </button>
      )}
    </pre>
  )
}

function JsonArray({ rows }: { rows: unknown[] }) {
  if (rows.length === 0) return <div className="text-xs text-muted-foreground">空数组</div>
  return <Pre value={rows} />
}

function NodeTable({ nodes }: { nodes: Record<string, unknown>[] }) {
  if (nodes.length === 0) return <div className="text-xs text-muted-foreground">没有节点</div>
  return (
    <div className="rounded border overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-muted">
          <tr>
            <th className="text-left px-2 py-1">ID</th>
            <th className="text-left px-2 py-1">名称</th>
            <th className="text-left px-2 py-1">协议</th>
            <th className="text-left px-2 py-1">地址</th>
          </tr>
        </thead>
        <tbody>
          {nodes.slice(0, 100).map((n, i) => (
            <tr key={i} className="border-t">
              <td className="px-2 py-1 font-mono">{String(n.id ?? "")}</td>
              <td className="px-2 py-1">{String(n.name ?? "")}</td>
              <td className="px-2 py-1">{String(n.protocol ?? "")}</td>
              <td className="px-2 py-1 font-mono">{String(n.host ?? "")}:{String(n.port ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {nodes.length > 100 && <div className="px-2 py-1 text-[10px] text-muted-foreground">仅显示前 100 条…</div>}
    </div>
  )
}

function FileTable({ entries, pathLabel }: { entries: Record<string, unknown>[]; pathLabel: string }) {
  return (
    <div>
      {pathLabel && <div className="text-xs text-muted-foreground mb-1">{pathLabel}</div>}
      <div className="rounded border overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted">
            <tr>
              <th className="text-left px-2 py-1">名称</th>
              <th className="text-left px-2 py-1">大小</th>
              <th className="text-left px-2 py-1">权限</th>
              <th className="text-left px-2 py-1">修改时间</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 50).map((e, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1">{Boolean(e.is_dir) ? "📁 " : "📄 "}{String(e.name ?? "")}</td>
                <td className="px-2 py-1 text-right font-mono">{Number(e.size || 0)}</td>
                <td className="px-2 py-1 font-mono text-muted-foreground">{String(e.mode ?? "")}</td>
                <td className="px-2 py-1 text-muted-foreground">{String(e.mod_time ?? "").slice(0, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length > 50 && <div className="px-2 py-1 text-[10px] text-muted-foreground">仅显示前 50 条…</div>}
      </div>
    </div>
  )
}
