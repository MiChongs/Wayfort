"use client"

import * as React from "react"
import Link from "next/link"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"
import {
  AArrowDown,
  AArrowUp,
  ArrowDownToLine,
  Bell,
  BellOff,
  ChevronDown,
  Clipboard,
  Copy,
  Download,
  Eraser,
  FolderTree,
  Maximize,
  Minimize,
  Plug,
  RotateCw,
  Search as SearchIcon,
  Send,
  X,
  Zap,
} from "lucide-react"
import { WebSSHConnection } from "@/lib/ws/webssh-client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const FONT_KEY = "webssh:fontSize"
const BELL_KEY = "webssh:bellEnabled"
const FONT_MIN = 10
const FONT_MAX = 22
const FONT_DEFAULT = 13

type Props = {
  protocol: "ssh" | "telnet" | "dbcli"
  nodeId: number
  displayName?: string
  username?: string
  host?: string
  port?: number
}

type Status = "connecting" | "open" | "closed"

// Inline scoped CSS that overrides xterm's default scrollbar with a
// shadcn-flavoured one. We target the `xterm-viewport` element inside the
// wrapper class so this doesn't leak to other xterm instances on the page.
// Webkit + Firefox both supported; the Tailwind theme tokens are inlined
// because xterm renders into a portal-like container that doesn't inherit
// arbitrary-selector classes cleanly.
const TERMINAL_SCROLLBAR_CSS = `
.webssh-scope .xterm-viewport {
  scrollbar-width: thin;
  scrollbar-color: rgba(161, 161, 170, 0.35) transparent;
  transition: scrollbar-color 150ms ease;
}
.webssh-scope .xterm-viewport:hover {
  scrollbar-color: rgba(161, 161, 170, 0.55) transparent;
}
.webssh-scope .xterm-viewport::-webkit-scrollbar {
  width: 10px;
  height: 10px;
  background: transparent;
}
.webssh-scope .xterm-viewport::-webkit-scrollbar-thumb {
  background-color: rgba(161, 161, 170, 0.35);
  border: 2px solid transparent;
  background-clip: content-box;
  border-radius: 6px;
  transition: background-color 150ms ease;
}
.webssh-scope .xterm-viewport:hover::-webkit-scrollbar-thumb {
  background-color: rgba(161, 161, 170, 0.55);
}
.webssh-scope .xterm-viewport::-webkit-scrollbar-thumb:active {
  background-color: rgba(244, 244, 245, 0.7);
}
.webssh-scope .xterm-viewport::-webkit-scrollbar-corner {
  background: transparent;
}
/* Hide the scrollbar entirely on touch devices that don't need it */
@media (hover: none) {
  .webssh-scope .xterm-viewport::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
}
`

export function WebSSHTerminal({ protocol, nodeId, displayName, username, host, port }: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const fitRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const searchRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
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
  const [bumpKey, setBumpKey] = React.useState(0)
  const [terminalTitle, setTerminalTitle] = React.useState<string>("")
  const [bellEnabled, setBellEnabled] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem(BELL_KEY) === "1"
  })
  const bellEnabledRef = React.useRef(bellEnabled)
  // Track whether the user has scrolled away from the bottom — when true we
  // show a "back to bottom" floating button instead of always anchoring.
  const [scrolledUp, setScrolledUp] = React.useState(false)
  // Multi-line paste confirmation guards against accidental rm -rf disasters.
  const [pasteConfirm, setPasteConfirm] = React.useState<string | null>(null)
  const reduced = useReducedMotion()

  React.useEffect(() => {
    bellEnabledRef.current = bellEnabled
    if (typeof window !== "undefined") {
      window.localStorage.setItem(BELL_KEY, bellEnabled ? "1" : "0")
    }
  }, [bellEnabled])

  React.useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  React.useEffect(() => {
    const t = termRef.current as { options?: { fontSize?: number } } | null
    if (t && t.options) t.options.fontSize = fontSize
    fitRef.current?.fit?.()
    if (typeof window !== "undefined") localStorage.setItem(FONT_KEY, String(fontSize))
  }, [fontSize])

  function themeColors() {
    if (typeof window === "undefined") return { fg: "#e4e4e7" }
    const styles = getComputedStyle(document.documentElement)
    const fg = styles.getPropertyValue("--foreground").trim() || "#e4e4e7"
    return { fg: oklchToHex(fg) || "#e4e4e7" }
  }

  React.useEffect(() => {
    let disposed = false
    let resizeObserver: ResizeObserver | undefined
    let viewport: HTMLDivElement | null = null
    let onViewportScroll: (() => void) | null = null
    setStatus("connecting")

    ;(async () => {
      const { Terminal } = await import("@xterm/xterm")
      const { FitAddon } = await import("@xterm/addon-fit")
      const { WebLinksAddon } = await import("@xterm/addon-web-links")
      const { SearchAddon } = await import("@xterm/addon-search")
      const { Unicode11Addon } = await import("@xterm/addon-unicode11")
      if (disposed) return

      const term = new Terminal({
        fontSize,
        cursorBlink: true,
        convertEol: true,
        scrollback: 5000,
        allowProposedApi: true,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        theme: {
          background: "#09090b",
          foreground: themeColors().fg,
          cursor: "#e4e4e7",
          cursorAccent: "#09090b",
          selectionBackground: "#3b82f680",
        },
      })
      const fit = new FitAddon()
      const search = new SearchAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.loadAddon(search)
      term.loadAddon(new Unicode11Addon())
      try {
        ;(term as { unicode: { activeVersion: string } }).unicode.activeVersion = "11"
      } catch {
        /* older xterm — falls back to Unicode 6 */
      }
      const el = containerRef.current!
      term.open(el)
      try {
        fit.fit()
      } catch {
        /* noop */
      }
      termRef.current = term
      fitRef.current = fit
      searchRef.current = search

      term.onTitleChange((t) => {
        if (!disposed) setTerminalTitle(t || "")
      })

      term.onBell(() => {
        if (!bellEnabledRef.current) return
        try {
          const AC =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
          const ac = new AC()
          const o = ac.createOscillator()
          const g = ac.createGain()
          o.connect(g)
          g.connect(ac.destination)
          o.frequency.value = 880
          g.gain.value = 0.05
          o.start()
          o.stop(ac.currentTime + 0.08)
          setTimeout(() => ac.close().catch(() => {}), 200)
        } catch {
          /* */
        }
      })

      el.addEventListener("click", () => {
        try {
          term.focus()
        } catch {
          /* */
        }
      })

      // Wire scrollback tracking to the xterm viewport so we can flip a
      // "back to bottom" button on/off without burning CPU on scroll.
      viewport = el.querySelector(".xterm-viewport") as HTMLDivElement | null
      if (viewport) {
        onViewportScroll = () => {
          if (!viewport) return
          const fromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
          setScrolledUp(fromBottom > 20)
        }
        viewport.addEventListener("scroll", onViewportScroll, { passive: true })
      }

      const path =
        protocol === "ssh"
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

      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true
        const k = e.key.toLowerCase()
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "c") {
          handleCopy(term)
          return false
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "v") {
          handlePaste(conn)
          return false
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "f") {
          setSearchOpen(true)
          return false
        }
        if (e.key === "F11") {
          toggleFullscreen()
          return false
        }
        return true
      })

      resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit()
        } catch {
          /* noop */
        }
      })
      resizeObserver.observe(el)
    })().catch((e) => toast.error("终端加载失败", { description: String(e) }))

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      if (viewport && onViewportScroll) viewport.removeEventListener("scroll", onViewportScroll)
      connRef.current?.close()
      const term = termRef.current as { dispose?: () => void } | null
      term?.dispose?.()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [protocol, nodeId, bumpKey]) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (!text) return
      // Confirm multi-line pastes so accidental Ctrl+V doesn't blast a 50-line
      // shell snippet straight into the prompt. Single-line pastes go through
      // unimpeded — they're the common case.
      if (text.includes("\n")) {
        setPasteConfirm(text)
        return
      }
      c.sendInput(text)
    } catch {
      toast.error("剪贴板读取被拒绝")
    }
  }

  function confirmPaste() {
    if (!pasteConfirm) return
    connRef.current?.sendInput(pasteConfirm)
    setPasteConfirm(null)
  }

  function handleClear() {
    const t = termRef.current as { clear?: () => void } | null
    t?.clear?.()
  }

  function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
  }

  function handleReconnect() {
    setBumpKey((v) => v + 1)
  }

  function handleDisconnect() {
    connRef.current?.close()
  }

  function searchNext(direction: "next" | "prev") {
    const s = searchRef.current as {
      findNext?: (q: string, o?: object) => boolean
      findPrevious?: (q: string, o?: object) => boolean
    } | null
    if (!s || !searchQuery) return
    if (direction === "next") s.findNext?.(searchQuery, { incremental: false })
    else s.findPrevious?.(searchQuery, { incremental: false })
  }

  // sendSignal injects a raw control byte. Used by the "send signal" menu so
  // people can interrupt / EOF / suspend remote processes without typing in
  // the terminal — handy when their cursor is in our toolbar input.
  function sendSignal(ctrlChar: string) {
    const c = connRef.current
    if (!c) return
    c.sendInput(ctrlChar)
  }

  function scrollToBottom() {
    const t = termRef.current as { scrollToBottom?: () => void } | null
    t?.scrollToBottom?.()
  }

  // Save the current scrollback as a text file. Pulls every line from the
  // active buffer (visible + scrollback), trimmed to keep file sizes sane.
  function saveScrollback() {
    const t = termRef.current as
      | {
          buffer: {
            active: { length: number; getLine: (i: number) => { translateToString: () => string } | undefined }
          }
        }
      | null
    if (!t) return
    const out: string[] = []
    const len = t.buffer.active.length
    for (let i = 0; i < len; i++) {
      const line = t.buffer.active.getLine(i)
      out.push(line?.translateToString().trimEnd() ?? "")
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop()
    const blob = new Blob([out.join("\n") + "\n"], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    a.href = url
    a.download = `${displayName || "session"}-${stamp}.log`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    toast.success("已保存", { description: a.download })
  }

  const fontDec = () => setFontSize((v) => Math.max(FONT_MIN, v - 1))
  const fontInc = () => setFontSize((v) => Math.min(FONT_MAX, v + 1))
  const fontReset = () => setFontSize(FONT_DEFAULT)

  const subtitle = [
    username && `${username}@`,
    host || displayName,
    port ? `:${port}` : "",
  ]
    .filter(Boolean)
    .join("")

  const liveTitle = terminalTitle && terminalTitle !== displayName ? terminalTitle : ""

  return (
    <TooltipProvider delayDuration={300}>
      <style>{TERMINAL_SCROLLBAR_CSS}</style>
      <div
        ref={wrapRef}
        className={cn(
          "webssh-scope flex flex-col h-full w-full bg-zinc-950 text-zinc-100 isolate",
          fullscreen && "fixed inset-0 z-[60]",
        )}
      >
        <header
          className={cn(
            "h-10 shrink-0 flex items-center gap-1 px-2",
            "border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/70",
          )}
        >
          <StatusDot status={status} />
          <div className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-xs font-medium text-zinc-100 truncate max-w-[160px]">
              {displayName || `node #${nodeId}`}
            </span>
            <Badge
              variant="outline"
              className="h-4 px-1.5 text-[10px] uppercase border-zinc-700 text-zinc-300 bg-zinc-900/60"
            >
              {protocol}
            </Badge>
            {subtitle && (
              <span className="text-[11px] text-zinc-400 font-mono truncate min-w-0">
                {subtitle}
              </span>
            )}
            {liveTitle && (
              <span className="text-[11px] text-zinc-500 font-mono truncate min-w-0 hidden md:inline">
                · {liveTitle}
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-0.5">
            {searchOpen && (
              <div className="flex items-center gap-0.5 mr-1.5 bg-zinc-900/80 border border-zinc-700/80 rounded-md px-1 py-0.5">
                <SearchIcon className="w-3 h-3 text-zinc-400 ml-1" />
                <Input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      searchNext(e.shiftKey ? "prev" : "next")
                    }
                    if (e.key === "Escape") setSearchOpen(false)
                  }}
                  placeholder="搜索…"
                  className="h-6 w-44 border-0 bg-transparent text-xs text-zinc-100 placeholder:text-zinc-500 shadow-none focus-visible:ring-0 px-1"
                />
                <ToolbarBtn onClick={() => searchNext("prev")} title="上一个 (Shift+Enter)" small>
                  <span className="text-xs">↑</span>
                </ToolbarBtn>
                <ToolbarBtn onClick={() => searchNext("next")} title="下一个 (Enter)" small>
                  <span className="text-xs">↓</span>
                </ToolbarBtn>
                <ToolbarBtn onClick={() => setSearchOpen(false)} title="关闭 (Esc)" small>
                  <X className="w-3 h-3" />
                </ToolbarBtn>
              </div>
            )}

            <IconBtn
              icon={SearchIcon}
              onClick={() => setSearchOpen((v) => !v)}
              title="搜索 (Ctrl+Shift+F)"
              active={searchOpen}
            />
            <IconBtn icon={Copy} onClick={() => handleCopy()} title="复制选区 (Ctrl+Shift+C)" />
            <IconBtn icon={Clipboard} onClick={() => handlePaste()} title="粘贴 (Ctrl+Shift+V)" />
            <IconBtn icon={Eraser} onClick={handleClear} title="清屏" />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={termBtnCls(false)}
                  aria-label="发送控制信号"
                  title="发送控制信号"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel className="text-xs">发送控制字符</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => sendSignal("\x03")} className="text-xs">
                  <Zap className="w-3.5 h-3.5" />
                  Ctrl+C — 中断 (SIGINT)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => sendSignal("\x04")} className="text-xs">
                  <Zap className="w-3.5 h-3.5" />
                  Ctrl+D — EOF / 退出
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => sendSignal("\x1a")} className="text-xs">
                  <Zap className="w-3.5 h-3.5" />
                  Ctrl+Z — 挂起 (SIGTSTP)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => sendSignal("\x0c")} className="text-xs">
                  <Zap className="w-3.5 h-3.5" />
                  Ctrl+L — 清屏
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <IconBtn
              icon={bellEnabled ? Bell : BellOff}
              onClick={() => setBellEnabled((v) => !v)}
              title={bellEnabled ? "关闭蜂鸣" : "启用蜂鸣"}
              active={bellEnabled}
            />
            <IconBtn icon={Download} onClick={saveScrollback} title="导出回滚为 .log" />

            {protocol === "ssh" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href={{ pathname: `/nodes/${nodeId}/sftp` }}
                    className={termBtnCls(false)}
                    aria-label="打开 SFTP 文件管理"
                  >
                    <FolderTree className="w-3.5 h-3.5" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="bottom">打开 SFTP 文件管理</TooltipContent>
              </Tooltip>
            )}

            <Separator orientation="vertical" className="bg-zinc-800 mx-0.5 h-5" />

            <IconBtn icon={AArrowDown} onClick={fontDec} title="字号 -" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={fontReset}
                  className="text-[11px] font-mono px-1.5 h-7 inline-flex items-center text-zinc-300 hover:text-white hover:bg-zinc-800 rounded-md transition-colors"
                  aria-label="重置字号"
                >
                  {fontSize}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">重置字号</TooltipContent>
            </Tooltip>
            <IconBtn icon={AArrowUp} onClick={fontInc} title="字号 +" />

            <Separator orientation="vertical" className="bg-zinc-800 mx-0.5 h-5" />

            <IconBtn
              icon={fullscreen ? Minimize : Maximize}
              onClick={toggleFullscreen}
              title={fullscreen ? "退出全屏 (F11)" : "全屏 (F11)"}
            />
            {status === "closed" ? (
              <IconBtn icon={RotateCw} onClick={handleReconnect} title="重新连接" variant="success" />
            ) : (
              <IconBtn icon={Plug} onClick={handleDisconnect} title="断开连接" variant="danger" />
            )}
          </div>
        </header>

        <div className="relative flex-1 min-h-0 bg-zinc-950">
          {status === "connecting" && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex items-center gap-2 text-sm text-zinc-400 px-3 py-1.5 rounded-full bg-zinc-900/60 border border-zinc-800/80">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                正在连接到 {host || displayName || "远端"}…
              </div>
            </div>
          )}
          <div ref={containerRef} className="absolute inset-0 p-1" />

          {/* "Back to bottom" floating button — appears when the user has
              scrolled up in the scrollback buffer. */}
          {scrolledUp && (
            <motion.button
              initial={reduced ? false : { opacity: 0, y: 8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? undefined : { opacity: 0, y: 8, scale: 0.95 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              onClick={scrollToBottom}
              className={cn(
                "absolute bottom-4 right-5 z-10",
                "inline-flex items-center gap-1.5 px-3 h-7 rounded-full",
                "bg-zinc-900/90 border border-zinc-700/80 text-xs text-zinc-200",
                "shadow-lg hover:bg-zinc-800 hover:border-zinc-600",
                "backdrop-blur transition-colors",
              )}
              aria-label="回到底部"
              title="回到底部"
            >
              <ArrowDownToLine className="w-3 h-3" />
              回到底部
            </motion.button>
          )}
        </div>

        <PasteConfirmDialog
          text={pasteConfirm}
          onConfirm={confirmPaste}
          onCancel={() => setPasteConfirm(null)}
        />
      </div>
    </TooltipProvider>
  )
}

function PasteConfirmDialog({
  text,
  onConfirm,
  onCancel,
}: {
  text: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const lines = text ? text.split("\n").length : 0
  const preview = text ? (text.length > 600 ? text.slice(0, 600) + "\n…" : text) : ""
  return (
    <Dialog open={!!text} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>粘贴 {lines} 行内容?</DialogTitle>
          <DialogDescription>
            多行粘贴会被立即执行,确认内容无误后再继续 —— 避免误粘脚本造成事故。
          </DialogDescription>
        </DialogHeader>
        <pre className="bg-muted rounded-md p-2 text-xs font-mono whitespace-pre overflow-auto max-h-60 text-foreground">
          {preview}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onConfirm}>确认粘贴</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StatusDot({ status }: { status: Status }) {
  const map: Record<Status, { dot: string; label: string }> = {
    connecting: { dot: "bg-amber-500", label: "连接中" },
    open: { dot: "bg-emerald-500", label: "已连接" },
    closed: { dot: "bg-red-500", label: "已断开" },
  }
  const s = map[status]
  return (
    <div className="flex items-center gap-1.5 mr-1.5 pl-1">
      <span className="relative inline-flex w-2 h-2 shrink-0">
        <span className={cn("absolute inset-0 rounded-full", s.dot)} />
        {status === "connecting" && (
          <span className={cn("absolute inset-0 rounded-full animate-ping", s.dot)} />
        )}
      </span>
      <span className="text-[11px] text-zinc-400">{s.label}</span>
    </div>
  )
}

function termBtnCls(active?: boolean, variant?: "success" | "danger") {
  return cn(
    "inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors outline-none",
    "text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:ring-1 focus-visible:ring-zinc-600",
    active && "bg-zinc-800 text-white",
    variant === "success" && "text-emerald-400 hover:text-emerald-300",
    variant === "danger" && "text-red-400 hover:text-red-300",
  )
}

function IconBtn({
  icon: Icon,
  onClick,
  title,
  active,
  variant,
}: {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
  active?: boolean
  variant?: "success" | "danger"
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={title}
          className={termBtnCls(active, variant)}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  )
}

function ToolbarBtn({
  onClick,
  title,
  small,
  children,
}: {
  onClick: () => void
  title: string
  small?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex items-center justify-center rounded-md transition-colors",
        "text-zinc-300 hover:text-white hover:bg-zinc-800",
        small ? "h-6 w-6" : "h-7 w-7",
      )}
    >
      {children}
    </button>
  )
}

// oklch(0.985 0 0) → #fafafa. xterm needs explicit RGB/HEX, so we crudely
// convert shadcn's CSS lightness to a hex gray.
function oklchToHex(oklch: string): string | null {
  const m = oklch.match(/oklch\(([\d.]+)/)
  if (!m) return null
  const l = parseFloat(m[1])
  const g = Math.round(l * 255)
  const hex = g.toString(16).padStart(2, "0")
  return `#${hex}${hex}${hex}`
}

// Compat: AArrowDown/AArrowUp icons (kept for callers that imported the
// re-exports). Newer callers don't need this.
