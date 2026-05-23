"use client"

import * as React from "react"
import { ChevronDown, ChevronRight, Gauge, GitBranch, Layers } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type Props = {
  // Each row of a PG EXPLAIN TEXT response is one line of the plan.
  // We accept the QueryResult.rows shape directly (any[][]) and pull
  // the first column as the plan text.
  rows: unknown[][]
  className?: string
}

// PlanNode is one parsed plan operator. Children indent under parent.
type PlanNode = {
  raw: string          // full original line (preserves alignment)
  text: string         // line with leading whitespace + "-> " stripped
  indent: number       // column-count of leading whitespace
  // Decoded fields when we can identify them (regex against the
  // canonical (cost=A..B rows=N width=K) suffix).
  op?: string          // node operator like "Seq Scan", "Hash Join"
  target?: string      // "on tbl", "using idx_xxx" — optional context
  costStart?: number
  costEnd?: number
  rows?: number
  width?: number
  // Children indented strictly deeper than `indent`.
  children: PlanNode[]
  // Metadata lines (Hash Cond, Filter, …) hanging off a node — shown
  // collapsed by default in the right column.
  attrs: string[]
}

// ExplainTree — render a PG EXPLAIN TEXT response as a collapsible tree.
// Auto-detects whether the rows actually look like a PG plan (first
// non-empty line starts with a recognised node operator); otherwise it
// returns null so the caller falls back to the plain table view.
export function ExplainTree({ rows, className }: Props) {
  const text = React.useMemo(() => {
    return rows
      .map((r) => (typeof r[0] === "string" ? r[0] : String(r[0] ?? "")))
      .join("\n")
  }, [rows])

  const tree = React.useMemo(() => parsePGExplainText(text), [text])
  // Bail when the parser doesn't see anything resembling a PG plan.
  // Caller (db-studio.tsx) renders the regular ResultGrid instead.
  if (!tree || tree.length === 0) return null

  return (
    <div className={cn("p-3 space-y-2 overflow-auto font-mono text-xs", className)}>
      {tree.map((n, i) => (
        <Node key={i} node={n} depth={0} />
      ))}
    </div>
  )
}

function Node({ node, depth }: { node: PlanNode; depth: number }) {
  const [open, setOpen] = React.useState(true)
  const hasChildren = node.children.length > 0 || node.attrs.length > 0
  // Cost-driven heat: cheap nodes muted, expensive nodes warm. The
  // ratio is relative to the root cost.
  const tone = costTone(node.costEnd ?? 0)
  return (
    <div className="relative">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          disabled={!hasChildren}
        >
          {hasChildren ? (
            open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
          ) : <span className="inline-block w-3 h-3" />}
        </button>
        <div className={cn(
          "flex-1 min-w-0 rounded-md border px-2 py-1.5",
          tone,
        )}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <Layers className="w-3 h-3 text-muted-foreground" />
            <span className="font-medium">{node.op ?? node.text}</span>
            {node.target && <span className="text-muted-foreground">{node.target}</span>}
            <span className="ml-auto inline-flex items-center gap-2 text-[10px] text-muted-foreground">
              {node.costEnd != null && (
                <span className="inline-flex items-center gap-0.5">
                  <Gauge className="w-3 h-3" />
                  cost {fmtNum(node.costStart)}…{fmtNum(node.costEnd)}
                </span>
              )}
              {node.rows != null && (
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  ≈{fmtNum(node.rows)} 行
                </Badge>
              )}
              {node.width != null && (
                <Badge variant="outline" className="text-[9px] px-1 py-0">
                  {node.width}B/行
                </Badge>
              )}
            </span>
          </div>
          {open && node.attrs.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
              {node.attrs.map((a, i) => (
                <li key={i} className="truncate" title={a}>· {a}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {open && node.children.length > 0 && (
        <div className="ml-4 mt-1 space-y-1 border-l border-dashed border-muted-foreground/20 pl-3">
          {node.children.map((c, i) => (
            <div key={i} className="relative">
              <GitBranch className="absolute -left-[14px] top-2 w-2.5 h-2.5 text-muted-foreground/50" />
              <Node node={c} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function fmtNum(n: number | undefined): string {
  if (n == null) return ""
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B"
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return n.toString()
}

// Soft heat-map: red border for the most expensive node, yellow for
// mid-tier, default for cheap. Looks at this node's costEnd against a
// running max baked in via React tree depth — close enough for at-a-
// glance "expensive ops" without re-traversing the tree.
function costTone(cost: number): string {
  if (cost > 100000) return "border-rose-500/40 bg-rose-50/40 dark:bg-rose-950/20"
  if (cost > 10000) return "border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20"
  if (cost > 1000) return "border-yellow-500/30 bg-yellow-50/30 dark:bg-yellow-950/10"
  return "border-border bg-card/50"
}

// parsePGExplainText converts a PG `EXPLAIN` TEXT block (one line per
// plan node + indented attr lines) into a tree of PlanNode. Each
// plan-operator line matches:
//
//   indent_spaces ("-> " prefix)? Operator [extra] (cost=A..B rows=N width=K)
//
// The depth of the `->` arrow determines parent — a deeper indent
// means a child of the most recent shallower node.
function parsePGExplainText(text: string): PlanNode[] | null {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const root: PlanNode[] = []
  const stack: { node: PlanNode; indent: number }[] = []
  let sawPlan = false

  const operatorRe = /^(\s*)(?:->\s*)?(.+?)\s*\(cost=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)\s+width=(\d+)\)\s*$/

  for (const raw of lines) {
    if (!raw.trim()) continue
    const m = raw.match(operatorRe)
    if (m) {
      sawPlan = true
      const indent = m[1].length
      const body = m[2].trim()
      const opMatch = body.match(/^([A-Z][A-Za-z ]+?)(?:\s+on\s+(.+))?$/)
      const node: PlanNode = {
        raw,
        text: body,
        indent,
        op: opMatch?.[1].trim() ?? body,
        target: opMatch?.[2]?.trim(),
        costStart: parseFloat(m[3]),
        costEnd: parseFloat(m[4]),
        rows: parseInt(m[5], 10),
        width: parseInt(m[6], 10),
        children: [],
        attrs: [],
      }
      // Pop the stack until the top is a strict parent of this indent.
      while (stack.length && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
      if (stack.length === 0) root.push(node)
      else stack[stack.length - 1].node.children.push(node)
      stack.push({ node, indent })
      continue
    }
    // Attribute line (Hash Cond, Filter, Buffers, ...). Attach to top
    // of stack if any; otherwise skip.
    const indent = raw.search(/\S/)
    const body = raw.trim()
    if (stack.length && indent > stack[stack.length - 1].indent) {
      stack[stack.length - 1].node.attrs.push(body)
    }
  }
  if (!sawPlan) return null
  return root
}
