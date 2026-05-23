"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { BarChart3, Hash, Loader2, X } from "lucide-react"
import { dbService } from "@/lib/api/services"

type Props = {
  nodeId: number
  database?: string
  schema: string
  table: string
  column: string
  // anchorEl positions the popover next to the clicked column header.
  // We use a fixed-position floating div anchored by the rect of the
  // anchor; mouse-leave on the entire popover closes it.
  anchorEl: HTMLElement
  onClose: () => void
}

// ColumnStatsPopover — floating data-exploration card for one column.
// Fetches /db/column_stats once on mount; renders distinct/null/total
// pills, min/max for orderable columns, and a top-N value bar list
// where the bar width is `freq / total`.
//
// Designed to NOT replace any existing affordance — it's purely
// informational so the operator can ask "what's in this column?"
// without typing a query.
export function ColumnStatsPopover({
  nodeId, database, schema, table, column, anchorEl, onClose,
}: Props) {
  const stats = useQuery({
    queryKey: ["db.colstats", nodeId, database, schema, table, column],
    queryFn: () => dbService.columnStats(nodeId, schema, table, column, { database, top: 10 }),
    staleTime: 60_000,
    retry: false,
  })

  // Anchored position: directly under the column header, left-aligned.
  // Falls back to top-left of viewport if the rect is offscreen.
  const [pos, setPos] = React.useState<{ left: number; top: number }>({ left: 0, top: 0 })
  React.useEffect(() => {
    const update = () => {
      const r = anchorEl.getBoundingClientRect()
      const left = Math.min(r.left, window.innerWidth - 360)
      const top = Math.min(r.bottom + 4, window.innerHeight - 360)
      setPos({ left: Math.max(8, left), top: Math.max(8, top) })
    }
    update()
    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [anchorEl])

  // Esc closes.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const s = stats.data
  const total = s?.total_count ?? 0

  return (
    <div
      className="fixed z-50 w-[340px] rounded-md border bg-popover shadow-xl text-xs"
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b">
        <BarChart3 className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="font-medium truncate flex-1">{column}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-destructive"
          title="关闭 (Esc)"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="p-3 space-y-3">
        {stats.isLoading && (
          <div className="grid place-items-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {stats.error && (
          <div className="text-destructive text-[10px] font-mono">
            {(stats.error as { message?: string }).message ?? "load failed"}
          </div>
        )}
        {s && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="总行数" value={s.total_count.toLocaleString()} />
              <Stat label="唯一值" value={s.distinct_count.toLocaleString()}
                hint={total > 0 ? `${((s.distinct_count / total) * 100).toFixed(1)}%` : ""} />
              <Stat label="NULL" value={s.null_count.toLocaleString()}
                hint={total > 0 ? `${((s.null_count / total) * 100).toFixed(1)}%` : ""} />
            </div>
            {(s.min_value || s.max_value) && (
              <div className="border-t pt-2">
                <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">值域</div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-[10px] text-muted-foreground">MIN</div>
                    <div className="font-mono text-[11px] truncate" title={s.min_value}>
                      {s.min_value || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground">MAX</div>
                    <div className="font-mono text-[11px] truncate" title={s.max_value}>
                      {s.max_value || "—"}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="border-t pt-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">
                <Hash className="w-3 h-3" /> 最常见值
              </div>
              {s.top_values.length === 0 ? (
                <div className="text-[10px] text-muted-foreground italic">表为空</div>
              ) : (
                <ul className="space-y-1">
                  {s.top_values.map((v, i) => {
                    const w = total > 0 ? Math.max(2, (v.frequency / total) * 100) : 0
                    return (
                      <li key={i} className="text-[11px]">
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono truncate flex-1" title={v.value}>
                            {v.value === "" ? <em className="text-muted-foreground">(空字符串)</em> : v.value}
                          </span>
                          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                            {v.frequency.toLocaleString()}
                          </span>
                        </div>
                        <div className="h-1 bg-muted rounded-full overflow-hidden mt-0.5">
                          <div
                            className="h-full bg-primary/60"
                            style={{ width: `${w}%` }}
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-muted/40 p-2">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="font-medium tabular-nums text-[12px]">{value}</div>
      {hint && <div className="text-[9px] text-muted-foreground">{hint}</div>}
    </div>
  )
}
