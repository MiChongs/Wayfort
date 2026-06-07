"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useTranslation } from "react-i18next"
import { ArrowDownToLine } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useTheme } from "next-themes"
import { toast } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WebSSHConnection, type SessionStats } from "@/lib/ws/webssh-client"
import {
  renderConnectBanner,
  renderDisconnectBanner,
  formatDuration,
} from "@/lib/terminal/banner"
import { inferDisconnect } from "@/lib/terminal/disconnect-reasons"
import { cn } from "@/lib/utils"
import { TerminalCommandPalette } from "./terminal-command-palette"
import { TerminalContextMenu } from "./terminal-context-menu"
import { TerminalHistorySheet } from "./terminal-history-sheet"
import { TerminalSearchPopover } from "./terminal-search-popover"
import { TerminalSettingsSheet } from "./terminal-settings-sheet"
import { TerminalSnippetsSheet } from "./terminal-snippets-sheet"
import { TerminalStatusBar } from "./terminal-status-bar"
import { TerminalToolbar } from "./terminal-toolbar"
import { PasteConfirmSheet } from "./paste-confirm-sheet"
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type TerminalSettings,
  useTerminalSettings,
} from "./use-terminal-settings"
import { resolveTerminalTheme } from "./terminal-themes"
import { useTerminalConnection } from "./terminal-connection"
import { TerminalConnectionStage } from "./terminal-connection-stage"
import type { SearchOptions, Status } from "./terminal-types"

export type { Status } from "./terminal-types"

// Backoff schedule for auto-reconnect on an unexpected drop. After the last
// one is exhausted the stage surfaces a manual-retry error panel.
const RECONNECT_BACKOFFS_MS = [1000, 2000, 4000]

type Props = {
  protocol: "ssh" | "telnet" | "dbcli"
  nodeId: number
  displayName?: string
  username?: string
  host?: string
  port?: number
  onStatusChange?: (status: Status) => void
  onOpenSftp?: () => void
}

// xterm renders into its own DOM under our container; this scoped CSS gives
// it a shadcn-flavoured scrollbar without affecting other xterm instances.
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
@media (hover: none) {
  .webssh-scope .xterm-viewport::-webkit-scrollbar { width: 0; height: 0; }
}
`

interface TerminalHandle {
  copy: () => void
  paste: () => void
  selectAll: () => void
  clear: () => void
  scrollToBottom: () => void
  getSelection: () => string
  setOptions: (patch: Record<string, unknown>) => void
  reloadAddons: () => void
  serializeAll: () => string
}

export function WebSSHTerminal({
  protocol,
  nodeId,
  displayName,
  username,
  host,
  port,
  onStatusChange,
  onOpenSftp,
}: Props) {
  const { settings, update, reset } = useTerminalSettings()
  const { resolvedTheme } = useTheme()
  const reduced = useReducedMotion()
  const { t } = useTranslation()
  const router = useRouter()

  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const fitRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const searchRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const serializeRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const webglRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const ligaturesRef = React.useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const connRef = React.useRef<WebSSHConnection | null>(null)
  const handleRef = React.useRef<TerminalHandle | null>(null)
  const fitRafRef = React.useRef<number | null>(null)
  // Lifecycle bookkeeping for the connect/disconnect banner pair.
  // `openedAt` is set the moment the server confirms READY (not socket
  // open), so the duration we display is what the user perceived as
  // session time — not the handshake overhead. `userClosed` is the
  // source of truth for "did the user click Disconnect or did the
  // network drop us?" — `handleDisconnect` flips it true *before*
  // calling `conn.close()`, and `onClose` reads it to pick the
  // farewell banner vs. the diagnostic banner.
  const openedAtRef = React.useRef<number>(0)
  const userClosedRef = React.useRef<boolean>(false)
  // Live mirror of `stats` for the onClose path — the handler captures
  // its closure once and can't see future state updates, so we read
  // through a ref instead.
  const statsRef = React.useRef<SessionStats>({ bytesIn: 0, bytesOut: 0 })

  // Status flows through a ref so the WS callbacks always invoke the latest
  // parent handler without retriggering the connect effect.
  const onStatusChangeRef = React.useRef(onStatusChange)
  React.useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  }, [onStatusChange])

  // Connection state machine — owns the phased timeline, reconnect countdown,
  // link quality and disconnect classification. `tc` (not `conn`, which is the
  // local WebSSHConnection inside the effect) so the two don't shadow.
  const tc = useTerminalConnection()
  const status = tc.status
  // Bridge status out to the workspace tab badge whenever it changes (fires on
  // mount too, covering the initial "connecting").
  React.useEffect(() => {
    onStatusChangeRef.current?.(status)
  }, [status])
  // Backoff bookkeeping for auto-reconnect — component refs so they persist
  // across the bumpKey-driven effect re-runs that a reconnect triggers.
  const reconnectAttemptRef = React.useRef(0)
  const reconnectTimerRef = React.useRef<number | null>(null)

  // UI overlays
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [searchOptions, setSearchOptions] = React.useState<SearchOptions>({
    regex: false,
    caseSensitive: false,
    wholeWord: false,
  })
  const [searchResults, setSearchResults] = React.useState({ index: 0, count: 0 })
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [fullscreen, setFullscreen] = React.useState(false)
  const [bumpKey, setBumpKey] = React.useState(0)
  const [terminalTitle, setTerminalTitle] = React.useState("")
  const [scrolledUp, setScrolledUp] = React.useState(false)
  const [pasteConfirm, setPasteConfirm] = React.useState<string | null>(null)
  const [hasSelection, setHasSelection] = React.useState(false)
  const [snippetsOpen, setSnippetsOpen] = React.useState(false)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const searchAnchorRef = React.useRef<HTMLButtonElement>(null)

  // Status bar metrics
  const [cols, setCols] = React.useState(80)
  const [rows, setRows] = React.useState(24)
  const [cursor, setCursor] = React.useState({ x: 0, y: 0 })
  const [stats, setStats] = React.useState<SessionStats>({ bytesIn: 0, bytesOut: 0 })
  const [latencyMs, setLatencyMs] = React.useState<number | null>(null)

  const settingsRef = React.useRef(settings)
  React.useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // Resolve theme palette — recomputes whenever the chosen theme or system
  // theme flips. The effect below applies it to the live terminal.
  const sysIsDark = resolvedTheme !== "light"
  const themePalette = React.useMemo(
    () => resolveTerminalTheme(settings.themeName, sysIsDark),
    [settings.themeName, sysIsDark],
  )

  const scheduleFit = React.useCallback(() => {
    if (typeof window === "undefined") return
    if (fitRafRef.current !== null) return
    fitRafRef.current = window.requestAnimationFrame(() => {
      fitRafRef.current = null
      const fit = fitRef.current as { fit?: () => void } | null
      const el = containerRef.current
      if (!fit?.fit || !el) return
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        /* noop */
      }
    })
  }, [])

  React.useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  // Apply live-tunable settings to an already-open xterm. Keeps changes
  // cheap — fontSize/lineHeight just bump options + fit; theme/cursor only
  // need options touched; ligatures + webgl get a re-load cycle.
  React.useEffect(() => {
    const term = termRef.current as { options?: Record<string, unknown> } | null
    if (!term?.options) return
    term.options.fontFamily = settings.fontFamily
    term.options.fontSize = settings.fontSize
    term.options.lineHeight = settings.lineHeight
    term.options.letterSpacing = settings.letterSpacing
    term.options.cursorStyle = settings.cursorStyle
    term.options.cursorBlink = settings.cursorBlink
    term.options.scrollback = settings.scrollback
    term.options.theme = themePalette.colors
    scheduleFit()
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.lineHeight,
    settings.letterSpacing,
    settings.cursorStyle,
    settings.cursorBlink,
    settings.scrollback,
    themePalette,
    scheduleFit,
  ])

  // Toggle WebGL renderer on/off without recreating the terminal.
  React.useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (settings.webglEnabled && !webglRef.current) {
      ;(async () => {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl")
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => {
            // GPU context lost (driver crash, tab moved between screens, etc).
            // Dispose so xterm falls back to its default DOM renderer.
            try {
              webgl.dispose()
            } catch {
              /* */
            }
            webglRef.current = null
          })
          term.loadAddon(webgl)
          webglRef.current = webgl
        } catch {
          /* webgl unavailable — keep default renderer */
        }
      })()
    } else if (!settings.webglEnabled && webglRef.current) {
      try {
        webglRef.current.dispose()
      } catch {
        /* */
      }
      webglRef.current = null
    }
  }, [settings.webglEnabled])

  // Toggle ligatures addon on/off.
  React.useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (settings.ligaturesEnabled && !ligaturesRef.current) {
      ;(async () => {
        try {
          const { LigaturesAddon } = await import("@xterm/addon-ligatures")
          const lig = new LigaturesAddon()
          term.loadAddon(lig)
          ligaturesRef.current = lig
        } catch {
          /* */
        }
      })()
    } else if (!settings.ligaturesEnabled && ligaturesRef.current) {
      try {
        ligaturesRef.current.dispose()
      } catch {
        /* */
      }
      ligaturesRef.current = null
    }
  }, [settings.ligaturesEnabled])

  // -------- main init effect ---------------------------------------------
  React.useEffect(() => {
    let disposed = false
    let resizeObserver: ResizeObserver | undefined
    let viewport: HTMLDivElement | null = null
    let onViewportScroll: (() => void) | null = null
    tc.start()

    ;(async () => {
      const { Terminal } = await import("@xterm/xterm")
      const { FitAddon } = await import("@xterm/addon-fit")
      const { WebLinksAddon } = await import("@xterm/addon-web-links")
      const { SearchAddon } = await import("@xterm/addon-search")
      const { Unicode11Addon } = await import("@xterm/addon-unicode11")
      const { ClipboardAddon } = await import("@xterm/addon-clipboard")
      const { SerializeAddon } = await import("@xterm/addon-serialize")
      if (disposed) return

      const initial = settingsRef.current
      const themeNow = resolveTerminalTheme(initial.themeName, sysIsDark)
      const term = new Terminal({
        fontFamily: initial.fontFamily,
        fontSize: initial.fontSize,
        lineHeight: initial.lineHeight,
        letterSpacing: initial.letterSpacing,
        cursorStyle: initial.cursorStyle,
        cursorBlink: initial.cursorBlink,
        scrollback: initial.scrollback,
        convertEol: true,
        allowProposedApi: true,
        allowTransparency: false,
        theme: themeNow.colors,
      })

      const fit = new FitAddon()
      const search = new SearchAddon()
      const serialize = new SerializeAddon()
      term.loadAddon(fit)
      term.loadAddon(new WebLinksAddon())
      term.loadAddon(search)
      term.loadAddon(new Unicode11Addon())
      term.loadAddon(new ClipboardAddon())
      term.loadAddon(serialize)
      try {
        ;(term as { unicode: { activeVersion: string } }).unicode.activeVersion = "11"
      } catch {
        /* older xterm — falls back to Unicode 6 */
      }

      const el = containerRef.current!
      term.open(el)
      termRef.current = term
      fitRef.current = fit
      searchRef.current = search
      serializeRef.current = serialize
      // First fit is deferred so the parent flex layout is settled before
      // xterm reads clientWidth/clientHeight — synchronous fit() here would
      // pop one frame later.
      scheduleFit()

      // Optional addons. Each load is independent and failure-tolerant.
      if (initial.webglEnabled) {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl")
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => {
            try {
              webgl.dispose()
            } catch {
              /* */
            }
            webglRef.current = null
          })
          term.loadAddon(webgl)
          webglRef.current = webgl
        } catch {
          /* */
        }
      }
      if (initial.ligaturesEnabled) {
        try {
          const { LigaturesAddon } = await import("@xterm/addon-ligatures")
          const lig = new LigaturesAddon()
          term.loadAddon(lig)
          ligaturesRef.current = lig
        } catch {
          /* */
        }
      }
      try {
        const { ImageAddon } = await import("@xterm/addon-image")
        term.loadAddon(new ImageAddon())
      } catch {
        /* */
      }

      // ---- term events ---------------------------------------------------
      term.onTitleChange((t) => !disposed && setTerminalTitle(t || ""))
      term.onResize(({ cols, rows }) => {
        setCols(cols)
        setRows(rows)
        connRef.current?.resize(cols, rows)
      })
      term.onCursorMove(() => {
        const b = term.buffer.active
        setCursor({ x: b.cursorX, y: b.cursorY })
      })
      term.onSelectionChange(() => setHasSelection(!!term.getSelection?.()))
      term.onBell(() => {
        if (!settingsRef.current.bellEnabled) return
        playBell()
      })

      // Search result tracking — surfaces match count / current index.
      search.onDidChangeResults?.((e: { resultIndex: number; resultCount: number }) => {
        setSearchResults({ index: e.resultIndex >= 0 ? e.resultIndex + 1 : 0, count: e.resultCount })
      })

      el.addEventListener("click", () => {
        try {
          term.focus()
        } catch {
          /* */
        }
      })

      // Scrollback position tracker
      viewport = el.querySelector(".xterm-viewport") as HTMLDivElement | null
      if (viewport) {
        onViewportScroll = () => {
          if (!viewport) return
          const fromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
          setScrolledUp(fromBottom > 20)
        }
        viewport.addEventListener("scroll", onViewportScroll, { passive: true })
      }

      // ---- WebSocket -----------------------------------------------------
      const path =
        protocol === "ssh"
          ? `/ws/ssh/${nodeId}`
          : protocol === "telnet"
            ? `/ws/telnet/${nodeId}`
            : `/ws/dbcli/${nodeId}`

      // Reset lifecycle counters on every (re)connect.
      userClosedRef.current = false
      openedAtRef.current = 0
      statsRef.current = { bytesIn: 0, bytesOut: 0 }

      // Diagnostic farewell for an unrecoverable drop — the classified banner
      // in the scrollback plus an actionable toast. Shared by the no-auto-
      // reconnect path and the "gave up after N attempts" path.
      function writeDiagnosticBanner(reason: string) {
        const info = inferDisconnect(reason)
        const reasonText = t(`terminal.disconnect.reason.${info.category}`)
        try {
          term.writeln(
            renderDisconnectBanner(term.cols, { kind: "unexpected", t, reason: reasonText, raw: info.raw }),
          )
        } catch {
          /* */
        }
        toast.error(t("terminal.disconnect.unexpected"), {
          description: reasonText,
          action: info.href
            ? {
                label: t(`terminal.disconnect.suggestion.${info.suggestion}`),
                onClick: () => router.push(info.href!),
              }
            : undefined,
        })
      }

      // Auto-reconnect on an unexpected drop: 1s/2s/4s backoff, with a live
      // countdown on the stage. A fresh attempt re-runs this effect (bumpKey),
      // re-creating the terminal — the old SSH session died with the socket, so
      // the new one is a clean shell. Gives up (error panel) after the last
      // backoff is exhausted.
      function scheduleReconnect(reason: string) {
        const attempt = reconnectAttemptRef.current
        if (attempt >= RECONNECT_BACKOFFS_MS.length) {
          // Classify the real last-drop reason (not a generic string) so the
          // error panel shows the actionable category + suggestion.
          tc.fail(reason)
          writeDiagnosticBanner(reason)
          return
        }
        const delay = RECONNECT_BACKOFFS_MS[attempt]
        reconnectAttemptRef.current = attempt + 1
        tc.beginReconnect(attempt + 1, delay)
        try {
          term.writeln(`\r\n\x1b[2m── 连接中断，${Math.round(delay / 1000)}s 后第 ${attempt + 1} 次重连 ──\x1b[0m`)
        } catch {
          /* */
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          setBumpKey((v) => v + 1)
        }, delay)
      }

      const conn = new WebSSHConnection(path, {
        onOpen: () => {
          // WS handshake done — encrypted channel up; SSH auth is next.
          if (!disposed) tc.markOpen()
        },
        onReady: () => {
          tc.markReady()
          reconnectAttemptRef.current = 0
          openedAtRef.current = Date.now()
          // Branded welcome banner — ANSI-coloured ASCII art + node
          // metadata. Banner module returns a string with internal
          // newlines, so write (not writeln) keeps it self-contained.
          term.write(
            renderConnectBanner(term.cols, {
              host: host || displayName || `node #${nodeId}`,
              user: username || "",
              protocol,
              t,
            }),
          )
        },
        onOutput: (bytes) => term.write(bytes),
        onError: (m) => toast.error(t("terminal.error.sessionError"), { description: m }),
        onClose: (m) => {
          if (userClosedRef.current) {
            // Friendly farewell — we know exactly what happened, so skip
            // diagnostics and surface a session summary instead.
            tc.close()
            const duration = formatDuration(openedAtRef.current ? Date.now() - openedAtRef.current : 0)
            const { bytesIn, bytesOut } = statsRef.current
            term.writeln(renderDisconnectBanner(term.cols, { kind: "user", t, duration, bytesIn, bytesOut }))
            toast.success(t("terminal.disconnect.userInitiated"), {
              description: t("terminal.disconnect.userInitiatedDetail", { duration, bytesIn, bytesOut }),
            })
            return
          }
          // Unexpected drop → auto-reconnect (if enabled) or surface the error.
          if (settingsRef.current.autoReconnect) {
            scheduleReconnect(m)
            return
          }
          tc.fail(m)
          writeDiagnosticBanner(m)
        },
        onStats: (s) => {
          statsRef.current = s
          setStats(s)
        },
        onLatency: (ms) => {
          setLatencyMs(ms)
          tc.pushLatency(ms)
        },
      })
      conn.open({ cols: term.cols, rows: term.rows })
      connRef.current = conn

      term.onData((d) => conn.sendInput(d))

      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true
        const k = e.key.toLowerCase()
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "c") {
          handleCopyInternal(term)
          return false
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "v") {
          handlePasteInternal(conn)
          return false
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "f") {
          setSearchOpen(true)
          return false
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "p") {
          setPaletteOpen(true)
          return false
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "i") {
          // Phase 11 — open snippets sheet
          setSnippetsOpen(true)
          return false
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "h") {
          // Phase 11 — open command history sheet
          setHistoryOpen(true)
          return false
        }
        if (e.key === "F11") {
          toggleFullscreen()
          return false
        }
        return true
      })

      resizeObserver = new ResizeObserver(() => scheduleFit())
      resizeObserver.observe(el)

      // Expose a handle the outer scope's callbacks can drive without
      // chasing termRef across closures.
      handleRef.current = {
        copy: () => handleCopyInternal(term),
        paste: () => handlePasteInternal(conn),
        selectAll: () => term.selectAll(),
        clear: () => term.clear(),
        scrollToBottom: () => term.scrollToBottom(),
        getSelection: () => term.getSelection?.() ?? "",
        setOptions: (patch) => Object.assign(term.options, patch),
        reloadAddons: () => {
          /* live-edit settings already handle this */
        },
        serializeAll: () => {
          try {
            return serialize.serialize()
          } catch {
            return ""
          }
        },
      }
    })().catch((e) => toast.error(t("terminal.error.loadFailed"), { description: String(e) }))

    return () => {
      disposed = true
      if (reconnectTimerRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      resizeObserver?.disconnect()
      if (fitRafRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(fitRafRef.current)
        fitRafRef.current = null
      }
      if (viewport && onViewportScroll) viewport.removeEventListener("scroll", onViewportScroll)
      connRef.current?.close()
      if (webglRef.current) {
        try {
          webglRef.current.dispose()
        } catch {
          /* */
        }
        webglRef.current = null
      }
      if (ligaturesRef.current) {
        try {
          ligaturesRef.current.dispose()
        } catch {
          /* */
        }
        ligaturesRef.current = null
      }
      const term = termRef.current as { dispose?: () => void } | null
      term?.dispose?.()
      termRef.current = null
      fitRef.current = null
      searchRef.current = null
      serializeRef.current = null
      handleRef.current = null
    }
  }, [protocol, nodeId, bumpKey, scheduleFit, sysIsDark]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run incremental search whenever query/options change so the result
  // counter updates without requiring Enter.
  React.useEffect(() => {
    const s = searchRef.current as
      | { findNext?: (q: string, o?: object) => boolean; clearDecorations?: () => void }
      | null
    if (!s) return
    if (!searchQuery) {
      s.clearDecorations?.()
      setSearchResults({ index: 0, count: 0 })
      return
    }
    s.findNext?.(searchQuery, {
      incremental: true,
      regex: searchOptions.regex,
      caseSensitive: searchOptions.caseSensitive,
      wholeWord: searchOptions.wholeWord,
    })
  }, [searchQuery, searchOptions])

  // -------- actions ------------------------------------------------------
  function handleCopyInternal(term: { getSelection: () => string }) {
    const sel = term.getSelection?.() || ""
    if (!sel) {
      toast(t("terminal.copy.empty"))
      return
    }
    navigator.clipboard.writeText(sel).then(
      () => toast.success(t("terminal.copy.success"), {
        description: t("terminal.copy.successDetail", { count: sel.length }),
      }),
      () => toast.error(t("terminal.error.clipboardWriteDenied")),
    )
  }

  async function handlePasteInternal(conn: WebSSHConnection) {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      if (text.includes("\n")) {
        setPasteConfirm(text)
        return
      }
      conn.sendInput(text)
    } catch {
      toast.error(t("terminal.error.clipboardReadDenied"))
    }
  }

  function confirmPaste() {
    if (!pasteConfirm) return
    connRef.current?.sendInput(pasteConfirm)
    setPasteConfirm(null)
  }

  function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
    else document.exitFullscreen?.().catch(() => {})
  }

  function sendSignal(ctrl: string) {
    connRef.current?.sendInput(ctrl)
  }

  function handleSearchNext(direction: "next" | "prev") {
    const s = searchRef.current as
      | { findNext?: (q: string, o?: object) => boolean; findPrevious?: (q: string, o?: object) => boolean }
      | null
    if (!s || !searchQuery) return
    const opts = {
      incremental: false,
      regex: searchOptions.regex,
      caseSensitive: searchOptions.caseSensitive,
      wholeWord: searchOptions.wholeWord,
    }
    if (direction === "next") s.findNext?.(searchQuery, opts)
    else s.findPrevious?.(searchQuery, opts)
  }

  function saveScrollback() {
    const ser = serializeRef.current as { serialize?: () => string } | null
    const text = ser?.serialize?.() ?? fallbackPlainScrollback()
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
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

  function fallbackPlainScrollback(): string {
    const t = termRef.current as
      | {
          buffer: {
            active: {
              length: number
              getLine: (i: number) => { translateToString: () => string } | undefined
            }
          }
        }
      | null
    if (!t) return ""
    const out: string[] = []
    const len = t.buffer.active.length
    for (let i = 0; i < len; i++) {
      out.push(t.buffer.active.getLine(i)?.translateToString().trimEnd() ?? "")
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop()
    return out.join("\n") + "\n"
  }

  // Front-end font +/- still respects the persisted settings — clamp on edge.
  function fontDec() {
    update({ fontSize: Math.max(FONT_SIZE_MIN, settings.fontSize - 1) })
  }
  function fontInc() {
    update({ fontSize: Math.min(FONT_SIZE_MAX, settings.fontSize + 1) })
  }
  function fontReset() {
    update({ fontSize: 14 })
  }
  function toggleBell() {
    update({ bellEnabled: !settings.bellEnabled })
  }
  function selectTheme(name: TerminalSettings["themeName"]) {
    update({ themeName: name })
    toast.success("主题已切换", { description: name })
  }
  function handleReconnect() {
    reconnectAttemptRef.current = 0
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    setBumpKey((v) => v + 1)
  }
  function handleDisconnect() {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    // Flag before close() so the upcoming onClose handler picks the
    // user-initiated branch (farewell banner + success toast), not the
    // unexpected-disconnect diagnostics path.
    userClosedRef.current = true
    connRef.current?.close()
    // Mid-backoff there's no live socket whose onClose can fire — settle the
    // state machine directly so the stage shows the closed panel.
    if (tc.status === "reconnecting") tc.close()
  }

  // -------- derived display strings --------------------------------------
  const subtitle = [username && `${username}@`, host || displayName, port ? `:${port}` : ""]
    .filter(Boolean)
    .join("")
  const liveTitle = terminalTitle && terminalTitle !== displayName ? terminalTitle : ""

  // -------- render -------------------------------------------------------
  return (
    <TooltipProvider delayDuration={300}>
      <style>{TERMINAL_SCROLLBAR_CSS}</style>
      <div
        ref={wrapRef}
        className={cn(
          "webssh-scope flex flex-col h-full w-full isolate",
          fullscreen && "fixed inset-0 z-[60]",
        )}
        style={{ background: themePalette.colors.background }}
      >
        <TerminalToolbar
          status={status}
          protocol={protocol}
          displayName={displayName}
          liveTitle={liveTitle}
          subtitle={subtitle}
          nodeId={nodeId}
          quality={tc.quality}
          fontSize={settings.fontSize}
          bellEnabled={settings.bellEnabled}
          searchActive={searchOpen}
          fullscreen={fullscreen}
          onCopy={() => handleRef.current?.copy()}
          onPaste={() => handleRef.current?.paste()}
          onClear={() => handleRef.current?.clear()}
          onSendSignal={sendSignal}
          onToggleBell={toggleBell}
          onExport={saveScrollback}
          onSearchToggle={() => setSearchOpen((v) => !v)}
          onSettings={() => setSettingsOpen(true)}
          onPalette={() => setPaletteOpen(true)}
          onFullscreen={toggleFullscreen}
          onFontDec={fontDec}
          onFontInc={fontInc}
          onFontReset={fontReset}
          onReconnect={handleReconnect}
          onDisconnect={handleDisconnect}
          onOpenSftp={onOpenSftp}
          onOpenSnippets={() => setSnippetsOpen(true)}
          onOpenHistory={() => setHistoryOpen(true)}
          searchTrigger={searchAnchorRef}
        />

        <TerminalContextMenu
          hasSelection={hasSelection}
          onCopy={() => handleRef.current?.copy()}
          onPaste={() => handleRef.current?.paste()}
          onSelectAll={() => handleRef.current?.selectAll()}
          onClear={() => handleRef.current?.clear()}
          onSearch={() => setSearchOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          onPalette={() => setPaletteOpen(true)}
          onSendSignal={sendSignal}
        >
          <div className="relative flex-1 min-h-0">
            <div ref={containerRef} className="absolute inset-0 p-1" />
            <TerminalConnectionStage
              conn={tc}
              nodeName={displayName}
              subtitle={subtitle}
              protocolLabel={protocol.toUpperCase()}
              onRetry={handleReconnect}
              onRetryNow={handleReconnect}
              onDisconnect={handleDisconnect}
              onNavigate={(href) => router.push(href)}
            />
            {scrolledUp && (
              <motion.button
                initial={reduced ? false : { opacity: 0, y: 8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduced ? undefined : { opacity: 0, y: 8, scale: 0.95 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                onClick={() => handleRef.current?.scrollToBottom()}
                className={cn(
                  "absolute bottom-4 right-5 z-10",
                  "inline-flex items-center gap-1.5 px-3 h-7 rounded-full",
                  "border bg-card/90 backdrop-blur text-xs",
                  "shadow-lg hover:bg-card transition-colors",
                )}
                aria-label="回到底部"
                title="回到底部"
              >
                <ArrowDownToLine className="w-3 h-3" />
                回到底部
              </motion.button>
            )}
          </div>
        </TerminalContextMenu>

        <TerminalStatusBar
          status={status}
          cols={cols}
          rows={rows}
          cursorX={cursor.x}
          cursorY={cursor.y}
          bytesIn={stats.bytesIn}
          bytesOut={stats.bytesOut}
          latencyMs={latencyMs}
          sessionMs={tc.sessionMs}
          latencyHistory={tc.latencyHistory}
          quality={tc.quality}
        />

        <TerminalSearchPopover
          open={searchOpen}
          onOpenChange={setSearchOpen}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          options={searchOptions}
          onOptionsChange={setSearchOptions}
          resultIndex={searchResults.index}
          resultCount={searchResults.count}
          onNext={() => handleSearchNext("next")}
          onPrev={() => handleSearchNext("prev")}
          anchor={searchAnchorRef}
        />

        <TerminalSettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          onChange={update}
          onReset={reset}
        />

        <TerminalCommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          actions={{
            onCopy: () => handleRef.current?.copy(),
            onPaste: () => handleRef.current?.paste(),
            onSearch: () => setSearchOpen(true),
            onClear: () => handleRef.current?.clear(),
            onExport: saveScrollback,
            onSettings: () => setSettingsOpen(true),
            onFontInc: fontInc,
            onFontDec: fontDec,
            onFontReset: fontReset,
            onFullscreen: toggleFullscreen,
            onToggleBell: toggleBell,
            bellEnabled: settings.bellEnabled,
            onSendSignal: sendSignal,
            onReconnect: handleReconnect,
            onDisconnect: handleDisconnect,
            onOpenSftp,
            onSelectTheme: selectTheme,
          }}
        />

        <PasteConfirmSheet
          text={pasteConfirm}
          onConfirm={confirmPaste}
          onCancel={() => setPasteConfirm(null)}
        />

        <TerminalSnippetsSheet
          open={snippetsOpen}
          onOpenChange={setSnippetsOpen}
          contextVars={{
            host: host ?? "",
            port: String(port ?? ""),
            user: username ?? "",
            node: displayName ?? "",
            node_id: String(nodeId),
          }}
          onInsert={(resolved) => {
            connRef.current?.sendInput(resolved)
          }}
        />
        <TerminalHistorySheet
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          nodeId={nodeId}
          onInsert={(cmd) => {
            connRef.current?.sendInput(cmd)
          }}
        />
      </div>
    </TooltipProvider>
  )
}

// PasteConfirmDialog was migrated to PasteConfirmSheet (Phase 11). The
// Sheet provides full vertical room for long pastes and keeps page context
// visible behind it.

function playBell() {
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
}
