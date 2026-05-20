"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Clock, Loader2, Play, Save, Square, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

// Monaco loads as a heavy ESM bundle; lazy-import to keep the route's
// first-paint small. SSR is off because Monaco needs the browser
// environment.
const Monaco = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="h-full grid place-items-center text-xs text-muted-foreground">
      <Loader2 className="w-4 h-4 animate-spin" />
    </div>
  ),
})

type Props = {
  nodeId: number
  value: string
  onChange: (v: string) => void
  onRun: (sql: string) => void
  busy?: boolean
  onCancel?: () => void
}

type HistoryEntry = {
  sql: string
  at: number
  ms?: number
  ok?: boolean
}

const HISTORY_KEY = (id: number) => `db.history.${id}`
const HISTORY_MAX = 50

// SQLEditor — Monaco editor + run button + local history.
// Keybindings:
//   Ctrl/Cmd+Enter   → execute selection if any, otherwise statement at cursor
//   Ctrl/Cmd+S       → save (no-op write to history, surfaces toast)
//
// Statement splitting: we don't try to parse SQL. The "statement at
// cursor" extraction splits on top-level semicolons (ignoring those
// inside single/double quotes) and picks whichever segment the cursor
// is in. Good enough for ad-hoc queries; a real parser is overkill.
export function SQLEditor({ nodeId, value, onChange, onRun, busy, onCancel }: Props) {
  const [history, setHistory] = React.useState<HistoryEntry[]>([])
  const editorRef = React.useRef<unknown>(null)

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY(nodeId))
      if (raw) setHistory(JSON.parse(raw) as HistoryEntry[])
    } catch {
      // ignore parse errors
    }
  }, [nodeId])

  const runNow = React.useCallback(() => {
    if (busy) return
    const ed = editorRef.current as { getSelection?: () => unknown; getModel?: () => unknown; getPosition?: () => { lineNumber: number; column: number } } | null
    let sql = value
    if (ed) {
      // Prefer explicit selection.
      const sel = (ed.getSelection?.() as { isEmpty?: () => boolean; startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | undefined)
      const model = ed.getModel?.() as { getValueInRange?: (r: unknown) => string; getValue?: () => string } | undefined
      if (sel && !sel.isEmpty?.() && model?.getValueInRange) {
        sql = model.getValueInRange(sel) || ""
      } else if (model?.getValue && ed.getPosition) {
        const all = model.getValue()
        const pos = ed.getPosition()
        sql = statementAtOffset(all, lineColToOffset(all, pos.lineNumber, pos.column)) || all
      }
    }
    sql = sql.trim()
    if (!sql) return
    pushHistory({ sql, at: Date.now() })
    onRun(sql)
  }, [busy, value, onRun])

  const pushHistory = (entry: HistoryEntry) => {
    setHistory((prev) => {
      // dedup with last entry if SQL is identical and very recent
      const next =
        prev.length && prev[0].sql === entry.sql
          ? [{ ...prev[0], at: entry.at }, ...prev.slice(1)]
          : [entry, ...prev]
      const trimmed = next.slice(0, HISTORY_MAX)
      try {
        localStorage.setItem(HISTORY_KEY(nodeId), JSON.stringify(trimmed))
      } catch {
        // quota — fine, history is best-effort
      }
      return trimmed
    })
  }

  const clearHistory = () => {
    setHistory([])
    try {
      localStorage.removeItem(HISTORY_KEY(nodeId))
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex flex-col h-full border rounded-md overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={runNow}
            disabled={busy || !value.trim()}
            className="h-7 gap-1"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            执行
          </Button>
          {busy && onCancel && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCancel}
              className="h-7 gap-1"
            >
              <Square className="w-3.5 h-3.5" /> 中止
            </Button>
          )}
          <kbd className="text-[10px] text-muted-foreground border rounded px-1 py-0.5">
            Ctrl/⌘ + Enter
          </kbd>
        </div>
        <div className="flex items-center gap-1">
          <HistoryButton history={history} onPick={(sql) => onChange(sql)} onClear={clearHistory} />
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Monaco
          height="100%"
          defaultLanguage="sql"
          theme="vs"
          value={value}
          onChange={(v) => onChange(v ?? "")}
          onMount={(editor, monaco) => {
            editorRef.current = editor
            const KeyMod = (monaco as { KeyMod: { CtrlCmd: number } }).KeyMod
            const KeyCode = (monaco as { KeyCode: { Enter: number; KeyS: number } }).KeyCode
            ;(editor as {
              addCommand: (kc: number, fn: () => void) => void
            }).addCommand(KeyMod.CtrlCmd | KeyCode.Enter, runNow)
            ;(editor as {
              addCommand: (kc: number, fn: () => void) => void
            }).addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => {
              // Suppress browser Save dialog; treat as "remember this".
              pushHistory({ sql: (value || "").trim(), at: Date.now() })
            })
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            renderLineHighlight: "gutter",
            tabSize: 2,
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
    </div>
  )
}

function HistoryButton({
  history,
  onPick,
  onClear,
}: {
  history: HistoryEntry[]
  onPick: (sql: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="h-7 px-2 text-xs gap-1"
      >
        <Clock className="w-3.5 h-3.5" /> 历史
      </Button>
      {open && (
        <div
          className="absolute right-0 top-9 z-20 w-96 rounded-md border bg-popover shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="flex items-center justify-between px-3 py-1.5 border-b">
            <span className="text-xs font-medium">最近 {history.length} 条</span>
            <button
              type="button"
              onClick={onClear}
              className="text-[10px] text-muted-foreground hover:text-destructive inline-flex items-center gap-0.5"
            >
              <Trash2 className="w-3 h-3" /> 清空
            </button>
          </div>
          <ScrollArea className="max-h-80">
            {history.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                还没有执行过
              </div>
            )}
            {history.map((h, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  onPick(h.sql)
                  setOpen(false)
                }}
                className={cn(
                  "w-full text-left px-3 py-1.5 hover:bg-muted/60 border-b last:border-b-0",
                  "font-mono text-[11px] truncate"
                )}
                title={h.sql}
              >
                <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                  <span>{new Date(h.at).toLocaleString()}</span>
                  {h.ms != null && <Save className="w-2.5 h-2.5" />}
                </div>
                <div className="truncate">{h.sql}</div>
              </button>
            ))}
          </ScrollArea>
        </div>
      )}
    </div>
  )
}

// statementAtOffset returns the SQL statement enclosing the cursor.
// Quotes (single + double) and dollar-quotes ($tag$...$tag$) are
// respected so a `;` inside a string doesn't split the statement.
function statementAtOffset(text: string, offset: number): string {
  const stmts: { start: number; end: number }[] = []
  let i = 0
  let start = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"') {
      const quote = c
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++
        i++
      }
      i++
      continue
    }
    if (c === "$" && /[a-zA-Z_]*\$/.test(text.slice(i + 1, i + 30))) {
      const tagEnd = text.indexOf("$", i + 1)
      const tag = text.slice(i, tagEnd + 1)
      const close = text.indexOf(tag, tagEnd + 1)
      if (close > 0) {
        i = close + tag.length
        continue
      }
    }
    if (c === ";") {
      stmts.push({ start, end: i })
      i++
      start = i
      continue
    }
    i++
  }
  if (start < text.length) stmts.push({ start, end: text.length })
  for (const s of stmts) {
    if (offset >= s.start && offset <= s.end) {
      return text.slice(s.start, s.end).trim()
    }
  }
  return text.trim()
}

function lineColToOffset(text: string, line: number, col: number): number {
  let n = 0
  let i = 0
  while (n < line - 1 && i < text.length) {
    if (text[i] === "\n") n++
    i++
  }
  return i + (col - 1)
}
