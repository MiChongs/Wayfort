"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Bookmark, BookmarkPlus, Clock, Loader2, Play, Save, Sparkles, Square, Trash2, Wand2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { formatSQL } from "@/lib/sql-format"
import { formatSQL as beautifySQL } from "@/components/db/editor/beautifier"
import { registerSchemaCompletion } from "@/components/db/editor/completion-provider"
import { useSchemaSnapshot } from "@/components/db/shared/schema-cache"

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
  // Slot rendered next to the Run button (e.g. EXPLAIN dropdown).
  extraActions?: React.ReactNode
  // Phase 2A — active database (drives the schema-completion snapshot)
  // + vendor label (drives the beautifier's SQL dialect). Optional so
  // the editor degrades gracefully when embedded without a DB context.
  database?: string
  vendorLabel?: string
}

type HistoryEntry = {
  sql: string
  at: number
  ms?: number
  ok?: boolean
}

const HISTORY_KEY = (id: number) => `db.history.${id}`
const HISTORY_MAX = 50

// Phase 30e — saved queries. Per-node localStorage-backed snippet
// library. Each entry is name + SQL; we deliberately don't persist
// server-side yet to avoid coupling to a new DB model — operators
// who switch browsers will rebuild their library, which is the same
// trade-off the editor history makes.
const SAVED_KEY = (id: number) => `db.saved.${id}`
const SAVED_MAX = 50

type SavedQuery = {
  id: string
  name: string
  sql: string
  at: number
}

// SQLEditor — Monaco editor + run button + local history.
// Keybindings:
//   Ctrl/Cmd+Enter   → execute selection if any, otherwise statement at cursor
//   Ctrl/Cmd+S       → save (no-op write to history, surfaces toast)
//
// Statement splitting: we don't try to parse SQL. The "statement at
// cursor" extraction splits on top-level semicolons (ignoring those
// inside single/double quotes) and picks whichever segment the cursor
// is in. Good enough for ad-hoc queries; a real parser is overkill.
export function SQLEditor({ nodeId, value, onChange, onRun, busy, onCancel, extraActions, database, vendorLabel }: Props) {
  const [history, setHistory] = React.useState<HistoryEntry[]>([])
  const [saved, setSaved] = React.useState<SavedQuery[]>([])
  const editorRef = React.useRef<unknown>(null)

  // Phase 2A.3 — schema-aware completion. monacoRef holds the Monaco
  // namespace handed to us in onMount; the completion provider is
  // re-registered whenever the cached snapshot or vendor changes, and
  // the prior registration is disposed first so we never leak providers
  // across a database switch.
  const monacoRef = React.useRef<typeof import("monaco-editor") | null>(null)
  const completionDisposeRef = React.useRef<{ dispose(): void } | null>(null)
  const { data: snapshot } = useSchemaSnapshot(nodeId, database ?? "")

  // Phase 2A.4 — beautify via sql-formatter. Shared by the toolbar
  // button and the Shift+Alt+F keybinding. The keybinding is bound once
  // at mount, so it routes through a ref to always run the freshest
  // closure (which reads the current editor value + vendor label).
  const doBeautify = React.useCallback(() => {
    const ed = editorRef.current as { getValue?: () => string } | null
    const cur = ed?.getValue?.() ?? value
    if (!cur.trim()) return
    try {
      onChange(beautifySQL(cur, vendorLabel ?? "mysql"))
      toast.success("已美化", { duration: 900 })
    } catch (e) {
      toast.error("美化失败：" + ((e as Error).message ?? ""))
    }
  }, [value, onChange, vendorLabel])
  const doBeautifyRef = React.useRef(doBeautify)
  doBeautifyRef.current = doBeautify

  React.useEffect(() => {
    const monacoApi = monacoRef.current
    if (!monacoApi || !snapshot) return
    completionDisposeRef.current?.dispose()
    const keywords = (vendorLabel ?? "").toLowerCase().includes("postgres")
      ? ["SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "RETURNING"]
      : ["SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE"]
    completionDisposeRef.current = registerSchemaCompletion(monacoApi, snapshot, keywords)
    return () => {
      completionDisposeRef.current?.dispose()
      completionDisposeRef.current = null
    }
  }, [snapshot, vendorLabel])

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY(nodeId))
      if (raw) setHistory(JSON.parse(raw) as HistoryEntry[])
      const sraw = localStorage.getItem(SAVED_KEY(nodeId))
      if (sraw) setSaved(JSON.parse(sraw) as SavedQuery[])
    } catch {
      // ignore parse errors
    }
  }, [nodeId])

  const persistSaved = React.useCallback((next: SavedQuery[]) => {
    setSaved(next)
    try { localStorage.setItem(SAVED_KEY(nodeId), JSON.stringify(next)) }
    catch { /* quota — best-effort */ }
  }, [nodeId])

  const saveCurrent = React.useCallback(() => {
    const sql = (value || "").trim()
    if (!sql) {
      toast.error("编辑器为空")
      return
    }
    const name = prompt("起个名字（如：查活跃会话）", summariseSavedName(sql)) ?? ""
    if (!name.trim()) return
    const entry: SavedQuery = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim(),
      sql,
      at: Date.now(),
    }
    const next = [entry, ...saved].slice(0, SAVED_MAX)
    persistSaved(next)
    toast.success("已保存到收藏")
  }, [value, saved, persistSaved])

  const removeSaved = React.useCallback((id: string) => {
    persistSaved(saved.filter((s) => s.id !== id))
  }, [saved, persistSaved])

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
          {/* Phase 30c — local SQL formatter. Keyword-based, no external
              dep, idempotent (run twice = same output). */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              try {
                const next = formatSQL(value)
                onChange(next)
                toast.success("已格式化", { duration: 900 })
              } catch (e) {
                toast.error("格式化失败：" + ((e as Error).message ?? ""))
              }
            }}
            disabled={busy || !value.trim()}
            className="h-7 px-2 gap-1 text-xs"
            title="格式化（关键字大写、子句换行）"
          >
            <Sparkles className="w-3.5 h-3.5" />
            格式化
          </Button>
          {/* Phase 2A.4 — full SQL beautifier (sql-formatter). Unlike
              the keyword-only 格式化 button above, this tokenizes by
              dialect for idiomatic indenting; Shift+Alt+F triggers it. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={doBeautify}
            disabled={busy || !value.trim()}
            className="h-7 px-2 gap-1 text-xs"
            title="美化（sql-formatter，按方言重排）— Shift+Alt+F"
          >
            <Wand2 className="w-3.5 h-3.5" />
            美化
          </Button>
          {extraActions}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={saveCurrent}
            disabled={busy || !value.trim()}
            className="h-7 px-2 text-xs gap-1"
            title="把当前 SQL 加入收藏（本机持久化）"
          >
            <BookmarkPlus className="w-3.5 h-3.5" /> 收藏
          </Button>
          <SavedButton saved={saved} onPick={(sql) => onChange(sql)} onRemove={removeSaved} />
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
            monacoRef.current = monaco
            const KeyMod = (
              monaco as { KeyMod: { CtrlCmd: number; Shift: number; Alt: number } }
            ).KeyMod
            const KeyCode = (
              monaco as { KeyCode: { Enter: number; KeyS: number; KeyF: number } }
            ).KeyCode
            ;(editor as {
              addCommand: (kc: number, fn: () => void) => void
            }).addCommand(KeyMod.CtrlCmd | KeyCode.Enter, runNow)
            ;(editor as {
              addCommand: (kc: number, fn: () => void) => void
            }).addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => {
              // Suppress browser Save dialog; treat as "remember this".
              pushHistory({ sql: (value || "").trim(), at: Date.now() })
            })
            // Phase 2A.4 — beautify shortcut. Bound once at mount; the
            // command delegates to a ref so it always runs the freshest
            // beautify closure (which reads the live editor value).
            ;(editor as {
              addCommand: (kc: number, fn: () => void) => void
            }).addCommand(
              KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF,
              () => doBeautifyRef.current(),
            )
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

function SavedButton({
  saved,
  onPick,
  onRemove,
}: {
  saved: SavedQuery[]
  onPick: (sql: string) => void
  onRemove: (id: string) => void
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
        <Bookmark className="w-3.5 h-3.5" /> 收藏 ({saved.length})
      </Button>
      {open && (
        <div
          className="absolute right-0 top-9 z-20 w-96 rounded-md border bg-popover shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          <div className="px-3 py-1.5 border-b text-xs font-medium">
            收藏的查询
          </div>
          <ScrollArea className="max-h-80">
            {saved.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                还没有收藏 — 写好 SQL 后点「收藏」起个名字
              </div>
            )}
            {saved.map((s) => (
              <div
                key={s.id}
                className="group flex items-start gap-2 px-3 py-1.5 hover:bg-muted/60 border-b last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => {
                    onPick(s.sql)
                    setOpen(false)
                  }}
                  className="flex-1 min-w-0 text-left"
                  title={s.sql}
                >
                  <div className="text-xs font-medium truncate">{s.name}</div>
                  <div className="text-[10px] text-muted-foreground font-mono truncate">
                    {s.sql.split("\n")[0]}
                  </div>
                </button>
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => onRemove(s.id)}
                  title="移除"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </ScrollArea>
        </div>
      )}
    </div>
  )
}

// summariseSavedName picks a sensible default name for a saved query
// from the first non-comment SQL line. Used as the prompt() default.
function summariseSavedName(sql: string): string {
  const stripped = sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
  const firstLine = stripped.split(/\r?\n/)[0] ?? ""
  if (firstLine.length <= 40) return firstLine || "未命名"
  return firstLine.slice(0, 37) + "…"
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
