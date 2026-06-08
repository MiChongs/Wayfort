"use client"

import * as React from "react"
import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Row = { id: number; k: string; v: string }

let seq = 0
const nextId = () => ++seq

function toObject(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.k.trim()
    if (k) out[k] = r.v
  }
  return out
}

/**
 * ProxyHeadersEditor — repeatable key/value rows for extra HTTP CONNECT request
 * headers. Self-managed row state (one-way: seeds from `value` on mount, emits
 * the assembled object on every edit); remount via a `key` to reset.
 */
export function ProxyHeadersEditor({
  value,
  onChange,
}: {
  value?: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const [rows, setRows] = React.useState<Row[]>(() =>
    Object.entries(value ?? {}).map(([k, v]) => ({ id: nextId(), k, v })),
  )

  const commit = (next: Row[]) => {
    setRows(next)
    onChange(toObject(next))
  }

  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={r.id} className="flex items-center gap-2">
          <Input
            value={r.k}
            placeholder="Header"
            className="h-8 flex-1 font-mono text-xs"
            onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
          />
          <Input
            value={r.v}
            placeholder="value"
            className="h-8 flex-1 font-mono text-xs"
            onChange={(e) => commit(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => commit(rows.filter((_, j) => j !== i))}
            aria-label="删除请求头"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8"
        onClick={() => commit([...rows, { id: nextId(), k: "", v: "" }])}
      >
        <Plus className="h-3.5 w-3.5" /> 添加请求头
      </Button>
    </div>
  )
}
