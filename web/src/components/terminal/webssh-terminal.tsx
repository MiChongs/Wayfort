"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  ALargeSmall, AArrowDown, AArrowUp, Copy, Clipboard, Eraser, Maximize, Minimize,
  Plug, Search as SearchIcon, Square, X, RotateCw,
} from "lucide-react"
import { WebSSHConnection } from "@/lib/ws/webssh-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

const FONT_KEY = "webssh:fontSize"
const FONT_MIN = 10
const FONT_MAX = 22
const FONT_DEFAULT = 13

type Props = {
  protocol: "ssh" | "telnet" | "dbcli"
  nodeId: number
  /** Optional metadata shown in the toolbar; safe to omit. */
  displayName?: string
  username?: string
  host?: string
  port?: number
}

type Status = "connecting" | "open" | "closed"

/**
 * WebSSH 终端：xterm.js 主体 + 一个 40px 高的工具条。
 *
 * 工具条提供：状态指示灯、节点元信息、字号、复制选区、粘贴、清屏、搜索、
 * 全屏、断开/重连。xterm 的字体大小、主题、addon 都按需懒载入，
 * 避免 SSR 报错。
 */
export function WebSSHTerminal({ protocol, nodeId, displayName, username, host, port }: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<any>(null)             // eslint-disable-line @typescript-eslint/no-explicit-any
  const fitRef = React.useRef<any>(null)              // eslint-disable-line @typescript-eslint/no-explicit-any
  const searchRef = React.useRef<any>(null)           // eslint-disable-line @typescript-eslint/no-explicit-any
  const connRef = React.useRef<WebSSHConnection | null>(null)
  const [status, setStatus] = React.useState<Status>("connecting")
  const [fontSize, setFontSize] = React.useState<number>(() => {
    if (typeof window === "undefined") return FONT_DEFAULT
    const v = Number(localStorage.getItem(FONT_KEY))
    return v >= FONT_MIN && v <= FONT_MAX ? v : FONT_DEFAULT
  })
  const [fullscreen, setFullscreen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [bumpKey, setBumpKey] = React.useState(0)   // increment to trigger reconnect

  // Track fullscreen state from the browser API (Esc exits).
  React.useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  // Update xterm font size whenever the slider/buttons change.
  React.useEffect(() => {
    const t = termRef.current as { options?: { fontSize?: number } } | null
    if (t && t.options) t.options.fontSize = fontSize
    fitRef.current?.fit?.()
    if (typeof window !== "undefined") localStorage.setItem(FONT_KEY, String(fontSize))
  }, [fontSize])

  // Read shadcn css variable to colour xterm against the current theme.
  function themeColors() {
    if (typeof window === "undefined") return { bg: "#09090b", fg: "#e4e4e7" }
    const styles = getComputedStyle(document.documentElement)
    const bg = styles.getPropertyValue("--background").trim() || "#09090b"
    const fg = styles.getPropertyValue("--foreground").trim() || "#e4e4e7"
    return { bg: oklchToHex(bg) || "#09090b", fg: oklchToHex(fg) || "#e4e4e7" }
  }

  React.useEffect(() => {
    let disposed = false
    let resizeObserver: ResizeObserver | undefined
    setStatus("connecting")

    ;(async () => {
      const { Terminal } = await import("@xterm/xterm")
      const { FitAddon } = await import("@xterm/addon-fit")
      const { WebLinksAddon } = await import("@xterm/addon-web-links")
      const { SearchAddon } = await import("@xterm/addon-search")
      if (disposed) return

      // Always paint on a known-dark surface — terminals look better dark even
      // in a light UI. We still pull foreground from the theme to keep accents
      // consistent.
      const term = new Terminal({
        fontSize,
        cursorBlink: true,
        convertEol: true,
        scrollback: 5000,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        theme: {
          background: "#09090b",
          foreground: themeColors().fg,
          cursor: "#e4e4e7",
          selectionBackground: "#3b82f680",
        },
      })
      const fit = new FitAddon()
      const search = new SearchAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.loadAddon(search)
      const el = containerRef.current!
      term.open(el)
      try { fit.fit() } catch { /* noop */ }
      termRef.current = term
      fitRef.current = fit
      searchRef.current = search

      const path = protocol === "ssh"
        ? `/ws/ssh/${nodeId}`
        : protocol === "telnet"
          ? `/ws/telnet/${nodeId}`
          : `/ws/dbcli/${nodeId}`

      const conn = new WebSSHConnection(path, {
        onReady: () => setStatus("open"),
        onOutput: (bytes) => term.write(bytes),
        onError: (m) => toast.error("会话错误", { description: m }),
        onClose: (m) => {
          setStatus("closed")
          term.writeln(`\r\n\x1b[33m[connection closed: ${m}]\x1b[0m`)
        },
      })
      conn.open({ cols: term.cols, rows: term.rows })
      connRef.current = conn

      term.onData((d) => conn.sendInput(d))
      term.onResize(({ cols, rows }) => conn.resize(cols, rows))

      // Custom shortcuts. Returning false stops xterm from forwarding the
      // event to the remote — we do that for our own shortcuts only.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true
        const k = e.key.toLowerCase()
        // Ctrl/Cmd-Shift-C — copy selection
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "c") {
          handleCopy(term)
          return false
        }
        // Ctrl/Cmd-Shift-V — paste
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "v") {
          handlePaste(conn)
          return false
        }
        // Ctrl/Cmd-Shift-F — search overlay
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "f") {
          setSearchOpen(true)
          return false
        }
        // F11 — fullscreen toggle
        if (e.key === "F11") {
          toggleFullscreen()
          return false
        }
        return true
      })

      resizeObserver = new ResizeObserver(() => {
        try { fit.fit() } catch { /* noop */ }
      })
      resizeObserver.observe(el)
    })().catch((e) => toast.error("终端加载失败", { description: String(e) }))

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      connRef.current?.close()
      const term = termRef.current as { dispose?: () => void } | null
      term?.dispose?.()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [protocol, nodeId, bumpKey])  // eslint-disable-line react-hooks/exhaustive-deps

  function handleCopy(term?: { getSelection: () => string }) {
    const t = term || (termRef.current as { getSelection?: () => string } | null)
    const sel = t?.getSelection?.() || ""
    if (!sel) {
      toast("没有选中文本")
      return
    }
    navigator.clipboard.writeText(sel).then(
      () => toast.success("已复制", { description: `${sel.length} 字符` }),
      () => toast.error("剪贴板被拒绝"),
    )
  }

  async function handlePaste(conn?: WebSSHConnection) {
    const c = conn || connRef.current
    if (!c) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) c.sendInput(text)
    } catch {
      toast.error("剪贴板读取被拒绝")
    }
  }

  function handleClear() {
    const t = termRef.current as { clear?: () => void } | null
    t?.clear?.()
  }

  function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => { /* */ })
    else document.exitFullscreen?.().catch(() => { /* */ })
  }

  function handleReconnect() {
    setBumpKey((v) => v + 1)
  }

  function handleDisconnect() {
    connRef.current?.close()
  }

  function searchNext(direction: "next" | "prev") {
    const s = searchRef.current as { findNext?: (q: string, o?: object) => boolean; findPrevious?: (q: string, o?: object) => boolean } | null
    if (!s || !searchQuery) return
    if (direction === "next") s.findNext?.(searchQuery, { incremental: false })
    else s.findPrevious?.(searchQuery, { incremental: false })
  }

  const fontDec = () => setFontSize((v) => Math.max(FONT_MIN, v - 1))
  const fontInc = () => setFontSize((v) => Math.min(FONT_MAX, v + 1))
  const fontReset = () => setFontSize(FONT_DEFAULT)

  const subtitle = [
    username && `${username}@`,
    host || displayName,
    port ? `:${port}` : "",
  ].filter(Boolean).join("")

  return (
    <div
      ref={wrapRef}
      className={cn(
        "flex flex-col h-full w-full bg-zinc-950 text-zinc-100",
        fullscreen && "fixed inset-0 z-[60]"
      )}
    >
      <div className="h-10 shrink-0 border-b border-zinc-800/80 bg-zinc-950 flex items-center gap-1 px-2">
        <StatusDot status={status} />
        <div className="text-xs font-medium truncate max-w-[200px]">
          {displayName || `node #${nodeId}`}
        </div>
        <span className="text-[11px] uppercase rounded bg-zinc-800 text-zinc-300 px-1.5 py-0.5">
          {protocol}
        </span>
        {subtitle && (
          <span className="text-[11px] text-zinc-400 font-mono truncate min-w-0">
            {subtitle}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {searchOpen && (
            <div className="flex items-center gap-1 mr-2 bg-zinc-900 border border-zinc-700 rounded px-1">
              <Input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); searchNext(e.shiftKey ? "prev" : "next") }
                  if (e.key === "Escape") setSearchOpen(false)
                }}
                placeholder="搜索…"
                className="h-7 w-44 border-0 bg-transparent text-xs text-zinc-100 placeholder:text-zinc-500 shadow-none focus-visible:ring-0"
              />
              <Button size="icon" variant="ghost" className="h-7 w-7 text-zinc-300 hover:text-white hover:bg-zinc-800" onClick={() => searchNext("prev")} title="上一个 (Shift+Enter)">↑</Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-zinc-300 hover:text-white hover:bg-zinc-800" onClick={() => searchNext("next")} title="下一个 (Enter)">↓</Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-zinc-300 hover:text-white hover:bg-zinc-800" onClick={() => setSearchOpen(false)} title="关闭 (Esc)">
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
          <ToolbarBtn icon={SearchIcon} onClick={() => setSearchOpen((v) => !v)} title="搜索 (Ctrl+Shift+F)" active={searchOpen} />
          <ToolbarBtn icon={Copy} onClick={() => handleCopy()} title="复制选区 (Ctrl+Shift+C)" />
          <ToolbarBtn icon={Clipboard} onClick={() => handlePaste()} title="粘贴 (Ctrl+Shift+V)" />
          <ToolbarBtn icon={Eraser} onClick={handleClear} title="清屏" />
          <div className="w-px h-5 bg-zinc-800 mx-0.5" />
          <ToolbarBtn icon={AArrowDown} onClick={fontDec} title="字号 -" />
          <button
            onClick={fontReset}
            className="text-[11px] font-mono px-1 text-zinc-300 hover:text-white hover:bg-zinc-800 rounded h-7"
            title="重置字号"
          >
            {fontSize}
          </button>
          <ToolbarBtn icon={AArrowUp} onClick={fontInc} title="字号 +" />
          <div className="w-px h-5 bg-zinc-800 mx-0.5" />
          <ToolbarBtn
            icon={fullscreen ? Minimize : Maximize}
            onClick={toggleFullscreen}
            title={fullscreen ? "退出全屏 (F11)" : "全屏 (F11)"}
          />
          {status === "closed" ? (
            <ToolbarBtn icon={RotateCw} onClick={handleReconnect} title="重新连接" variant="success" />
          ) : (
            <ToolbarBtn icon={Plug} onClick={handleDisconnect} title="断开连接" variant="danger" />
          )}
        </div>
      </div>
      <div className="relative flex-1 min-h-0 bg-zinc-950">
        {status === "connecting" && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400 pointer-events-none">
            正在连接…
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0 p-1" />
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: Status }) {
  const map: Record<Status, { dot: string; label: string }> = {
    connecting: { dot: "bg-amber-500", label: "正在连接" },
    open:       { dot: "bg-emerald-500", label: "已连接" },
    closed:     { dot: "bg-red-500", label: "已断开" },
  }
  const s = map[status]
  return (
    <div className="flex items-center gap-1.5 mr-2 pl-1">
      <span className={cn("inline-block w-2 h-2 rounded-full", s.dot, status === "connecting" && "animate-pulse")} />
      <span className="text-[11px] text-zinc-400">{s.label}</span>
    </div>
  )
}

function ToolbarBtn({
  icon: Icon, onClick, title, active, variant,
}: {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
  active?: boolean
  variant?: "success" | "danger"
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center justify-center h-7 w-7 rounded transition-colors",
        "text-zinc-400 hover:text-white hover:bg-zinc-800",
        active && "bg-zinc-800 text-white",
        variant === "success" && "text-emerald-400 hover:text-emerald-300",
        variant === "danger" && "text-red-400 hover:text-red-300",
      )}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  )
}

// oklch(0.985 0 0) → #fafafa  (rough conversion for the two CSS variables we
// pull from shadcn; xterm needs explicit RGB/HEX, doesn't accept oklch).
function oklchToHex(oklch: string): string | null {
  const m = oklch.match(/oklch\(([\d.]+)/)
  if (!m) return null
  const l = parseFloat(m[1])
  const g = Math.round(l * 255)
  const hex = g.toString(16).padStart(2, "0")
  return `#${hex}${hex}${hex}`
}

// Silence un-used import warnings — exported icon kept around for callers.
export { ALargeSmall, Square }
