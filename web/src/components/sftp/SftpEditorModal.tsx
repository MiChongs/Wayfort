"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Loader2, Save, X } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { sftpService, type SftpEntry } from "@/lib/api/services"
import { useConfirm } from "@/components/admin/use-confirm"
import { fmtBytes } from "@/lib/format"
import { basename, extension } from "./pathUtil"

// Monaco is heavy; load it only when the editor actually opens.
const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      <Loader2 className="w-4 h-4 animate-spin mr-2" /> 加载编辑器…
    </div>
  ),
})

type Props = {
  nodeId: number
  entry: SftpEntry | null
  onClose: () => void
  onSaved?: () => void
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  go: "go",
  py: "python",
  rb: "ruby",
  rs: "rust",
  php: "php",
  java: "java",
  kt: "kotlin",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  h: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  sql: "sql",
  xml: "xml",
  dockerfile: "dockerfile",
}

function langForName(name: string): string {
  if (name.toLowerCase() === "dockerfile") return "dockerfile"
  if (name.toLowerCase() === "makefile") return "makefile"
  return LANG_BY_EXT[extension(name)] || "plaintext"
}

export function SftpEditorModal({ nodeId, entry, onClose, onSaved }: Props) {
  const [content, setContent] = React.useState("")
  const [original, setOriginal] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [truncated, setTruncated] = React.useState(false)
  const [theme, setTheme] = React.useState<"vs" | "vs-dark">("vs")

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const m = window.matchMedia("(prefers-color-scheme: dark)")
    const sync = () => setTheme(m.matches || document.documentElement.classList.contains("dark") ? "vs-dark" : "vs")
    sync()
    m.addEventListener("change", sync)
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => {
      m.removeEventListener("change", sync)
      observer.disconnect()
    }
  }, [])

  React.useEffect(() => {
    if (!entry) {
      setContent("")
      setOriginal("")
      setError(null)
      setTruncated(false)
      return
    }
    setLoading(true)
    setError(null)
    let cancelled = false
    sftpService
      .readText(nodeId, entry.path)
      .then((r) => {
        if (cancelled) return
        setContent(r.content)
        setOriginal(r.content)
        setTruncated(r.truncated)
      })
      .catch((e: { message?: string }) => {
        if (cancelled) return
        const msg = e?.message || "无法读取"
        setError(msg)
        toast.error("打开失败", { description: msg })
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [entry, nodeId])

  const dirty = content !== original
  const language = entry ? langForName(entry.name) : "plaintext"

  const onSave = React.useCallback(async () => {
    if (!entry || saving || truncated) return
    setSaving(true)
    try {
      await sftpService.writeText(nodeId, entry.path, content)
      setOriginal(content)
      toast.success("已保存", { description: entry.path })
      onSaved?.()
    } catch (e) {
      const err = e as { message?: string }
      toast.error("保存失败", { description: err?.message || String(e) })
    } finally {
      setSaving(false)
    }
  }, [content, entry, nodeId, onSaved, saving, truncated])

  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm()
  const onRequestClose = React.useCallback(async () => {
    if (dirty) {
      const ok = await confirmDiscard({
        title: "放弃未保存的修改？",
        description: "关闭后本次编辑不会保存。",
        confirmLabel: "放弃",
      })
      if (!ok) return
    }
    onClose()
  }, [dirty, confirmDiscard, onClose])

  // Save shortcut. Listen on capture so Monaco doesn't swallow it.
  React.useEffect(() => {
    if (!entry) return
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault()
        void onSave()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [entry, onSave])

  return (
    <>
    <Dialog open={!!entry} onOpenChange={(v) => !v && void onRequestClose()}>
      <DialogContent className="max-w-5xl w-[min(1100px,calc(100vw-2rem))] h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-4 py-3 border-b flex-row items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate flex items-center gap-2">
              {entry ? basename(entry.path) : ""}
              {dirty && <span className="text-xs text-amber-500">●</span>}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs truncate">
              {entry?.path}
              {entry && (
                <span className="ml-2 text-muted-foreground">
                  · {fmtBytes(content.length)} · {language}
                  {truncated && " · 文件过大已截断，禁止保存"}
                </span>
              )}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              onClick={() => void onSave()}
              disabled={saving || !dirty || truncated || loading || !!error}
            >
              <Save className="w-4 h-4" />
              {saving ? "保存中…" : "保存 (⌘/Ctrl+S)"}
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRequestClose} title="关闭">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> 加载中…
            </div>
          ) : error ? (
            <div className="p-6 text-sm text-destructive">{error}</div>
          ) : (
            <MonacoEditor
              height="100%"
              language={language}
              theme={theme}
              value={content}
              onChange={(v) => setContent(v ?? "")}
              options={{
                automaticLayout: true,
                fontSize: 13,
                minimap: { enabled: false },
                wordWrap: "on",
                tabSize: 2,
                renderWhitespace: "selection",
                scrollBeyondLastLine: false,
                readOnly: truncated,
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
    {discardDialog}
    </>
  )
}
