"use client"

// In-browser player for the freerdp ".dtr" session tape. Replays the recorded
// desktop.v2 frame stream through the SAME canvas-renderer + decode.worker
// pipeline the live viewer uses (so every codec — raw/JPEG/PNG/zlib/H264 — just
// works), and renders an audit timeline (reconstructed keystrokes, mouse/
// clipboard events, connect/resize/error milestones) beside it.

import * as React from "react"
import { Pause, Play, SkipBack } from "lucide-react"
import { createRenderer, type CanvasRendererHandle, type FrameBytes } from "@/lib/desktop/canvas-renderer"
import { decodeOutput, parseDtr, type DtrTape, type DtrTimelineEntry } from "@/lib/desktop/recording"
import { cn } from "@/lib/utils"

const SPEEDS = [0.5, 1, 2, 4] as const

export function DesktopRecordingPlayer({ url }: { url: string }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const rendererRef = React.useRef<CanvasRendererHandle | null>(null)
  const tapeRef = React.useRef<DtrTape | null>(null)

  // Replay clock + cursor live in refs so the rAF loop never reads stale state.
  const rafRef = React.useRef<number>(0)
  const lastTickRef = React.useRef<number>(0)
  const curMsRef = React.useRef<number>(0)
  const dispMsRef = React.useRef<number>(0) // last value pushed to React state (throttled)
  const paintIdxRef = React.useRef<number>(0) // next output index to paint forward
  const playingRef = React.useRef<boolean>(false)
  const speedRef = React.useRef<number>(1)

  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = React.useState<string>("")
  const [playing, setPlaying] = React.useState(false)
  const [curMs, setCurMs] = React.useState(0)
  const [durationMs, setDurationMs] = React.useState(0)
  const [speed, setSpeed] = React.useState<number>(1)
  const [timeline, setTimeline] = React.useState<DtrTimelineEntry[]>([])

  // ---- replay engine -------------------------------------------------------

  const paintRange = React.useCallback((fromIdx: number, toMs: number): number => {
    const tape = tapeRef.current
    const r = rendererRef.current
    if (!tape || !r) return fromIdx
    const batch: FrameBytes[] = []
    let i = fromIdx
    for (; i < tape.outputs.length; i++) {
      const rec = tape.outputs[i]
      if (rec.tMs > toMs) break
      const frames = decodeOutput(tape.buf, rec)
      for (const f of frames) batch.push(f)
    }
    if (batch.length > 0) r.paintFrameBatchBytes(batch)
    return i
  }, [])

  const seek = React.useCallback(
    (targetMs: number) => {
      const tape = tapeRef.current
      const r = rendererRef.current
      if (!tape || !r) return
      const target = Math.max(0, Math.min(targetMs, tape.durationMs))
      // Find the nearest resync (full repaint / keyframe) at or before target so
      // scrubbing is cheap and H.264 restarts from an IDR.
      let resync = 0
      for (let i = 0; i < tape.outputs.length; i++) {
        const rec = tape.outputs[i]
        if (rec.tMs > target) break
        if (rec.resync) resync = i
      }
      paintIdxRef.current = paintRange(resync, target)
      curMsRef.current = target
      dispMsRef.current = target
      setCurMs(target)
    },
    [paintRange],
  )

  const tick = React.useCallback(
    (now: number) => {
      const tape = tapeRef.current
      if (!tape || !playingRef.current) return
      const dt = lastTickRef.current ? now - lastTickRef.current : 0
      lastTickRef.current = now
      let cur = curMsRef.current + dt * speedRef.current
      let stop = false
      if (cur >= tape.durationMs) {
        cur = tape.durationMs
        stop = true
      }
      paintIdxRef.current = paintRange(paintIdxRef.current, cur)
      curMsRef.current = cur
      // Throttle the display state to ~15 fps so a long audit timeline doesn't
      // re-render every frame; painting above uses refs and stays smooth.
      if (stop || Math.abs(cur - dispMsRef.current) >= 66) {
        dispMsRef.current = cur
        setCurMs(cur)
      }
      if (stop) {
        playingRef.current = false
        setPlaying(false)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [paintRange],
  )

  const play = React.useCallback(() => {
    const tape = tapeRef.current
    if (!tape) return
    if (curMsRef.current >= tape.durationMs) {
      // Restart from the top.
      seek(0)
    }
    playingRef.current = true
    setPlaying(true)
    lastTickRef.current = 0
    rafRef.current = requestAnimationFrame(tick)
  }, [seek, tick])

  const pause = React.useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
  }, [])

  // ---- load + mount --------------------------------------------------------

  React.useEffect(() => {
    let cancelled = false
    setStatus("loading")
    ;(async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        if (cancelled) return
        const tape = parseDtr(buf)
        tapeRef.current = tape
        const renderer = createRenderer(tape.width || 1280, tape.height || 720)
        rendererRef.current = renderer
        const host = hostRef.current
        if (host) {
          host.innerHTML = ""
          host.appendChild(renderer.canvas)
          renderer.canvas.style.maxWidth = "100%"
          renderer.canvas.style.maxHeight = "100%"
        }
        setDurationMs(tape.durationMs)
        setTimeline(tape.timeline)
        setStatus("ready")
        // Paint the opening frame so the canvas isn't blank before play.
        paintIdxRef.current = paintRange(0, 0)
      } catch (e) {
        if (!cancelled) {
          setError(String(e instanceof Error ? e.message : e))
          setStatus("error")
        }
      }
    })()
    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rendererRef.current?.destroy()
      rendererRef.current = null
      tapeRef.current = null
    }
  }, [url, paintRange])

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = Number(e.target.value)
    const wasPlaying = playingRef.current
    if (wasPlaying) pause()
    seek(target)
    if (wasPlaying) play()
  }

  const changeSpeed = (s: number) => {
    speedRef.current = s
    setSpeed(s)
  }

  // Reconstruct a compact, human-readable audit timeline from the raw records.
  const auditRows = React.useMemo(() => buildAuditRows(timeline), [timeline])
  // The event markers shown on the seek bar (connect/resize/error/clipboard).
  const markers = React.useMemo(
    () => timeline.filter((t) => t.kind === "event"),
    [timeline],
  )

  if (status === "error") {
    return <div className="text-sm text-destructive">录像加载失败：{error}</div>
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
      {/* Player */}
      <div className="space-y-2">
        <div className="relative rounded-md overflow-hidden border bg-black aspect-video flex items-center justify-center">
          <div ref={hostRef} className="w-full h-full flex items-center justify-center" />
          {status === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
              加载录像中…
            </div>
          )}
        </div>

        {/* Transport */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => seek(0)}
            className="inline-flex items-center justify-center h-8 w-8 rounded-md border hover:bg-accent"
            title="回到开头"
            aria-label="回到开头"
            disabled={status !== "ready"}
          >
            <SkipBack className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => (playing ? pause() : play())}
            className="inline-flex items-center justify-center h-8 w-8 rounded-md border hover:bg-accent"
            title={playing ? "暂停" : "播放"}
            aria-label={playing ? "暂停" : "播放"}
            disabled={status !== "ready"}
          >
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>

          {/* Seek bar with event markers */}
          <div className="relative flex-1">
            <input
              type="range"
              min={0}
              max={Math.max(1, durationMs)}
              value={curMs}
              onChange={onScrub}
              disabled={status !== "ready"}
              className="w-full accent-primary"
              aria-label="播放进度"
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-1">
              {durationMs > 0 &&
                markers.map((m, i) => (
                  <span
                    key={i}
                    title={describeEvent(m)}
                    className={cn(
                      "absolute top-0 w-[2px] h-2 -translate-x-1/2 rounded",
                      eventTone(String(m.data.type ?? "")),
                    )}
                    style={{ left: `${(m.tMs / durationMs) * 100}%` }}
                  />
                ))}
            </div>
          </div>

          <span className="text-xs tabular-nums text-muted-foreground w-24 text-right">
            {fmtClock(curMs)} / {fmtClock(durationMs)}
          </span>

          <div className="flex items-center gap-0.5">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => changeSpeed(s)}
                className={cn(
                  "h-7 px-1.5 rounded text-xs tabular-nums border",
                  speed === s ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent",
                )}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Audit timeline */}
      <div className="rounded-md border flex flex-col min-h-[280px] max-h-[520px]">
        <div className="px-3 py-2 border-b text-sm font-medium flex items-center justify-between">
          <span>审计时间线</span>
          <span className="text-xs text-muted-foreground">{auditRows.length} 条</span>
        </div>
        <div className="flex-1 overflow-auto text-xs">
          {auditRows.length === 0 ? (
            <div className="p-3 text-muted-foreground">无输入/事件记录</div>
          ) : (
            <ul className="divide-y">
              {auditRows.map((row, i) => {
                const active = curMs >= row.tMs && (i === auditRows.length - 1 || curMs < auditRows[i + 1].tMs)
                return (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => seek(row.tMs)}
                      className={cn(
                        "w-full text-left px-3 py-1.5 flex gap-2 hover:bg-accent/60 transition-colors",
                        active && "bg-accent",
                      )}
                    >
                      <span className="tabular-nums text-muted-foreground shrink-0 w-12">{fmtClock(row.tMs)}</span>
                      <span className={cn("shrink-0 w-12", row.tone)}>{row.kind}</span>
                      <span className="min-w-0 break-words font-mono">{row.text}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- audit timeline reconstruction -----------------------------------------

interface AuditRow {
  tMs: number
  kind: string
  tone: string
  text: string
}

// buildAuditRows collapses raw INPUT/EVENT records into a readable list:
// consecutive key-downs become a single "typed text" row; mouse/clipboard/event
// records each get a row.
function buildAuditRows(timeline: DtrTimelineEntry[]): AuditRow[] {
  const rows: AuditRow[] = []
  let typing: { tMs: number; text: string } | null = null
  const flush = () => {
    if (typing && typing.text) {
      rows.push({ tMs: typing.tMs, kind: "键入", tone: "text-emerald-600 dark:text-emerald-400", text: typing.text })
    }
    typing = null
  }
  for (const e of timeline) {
    if (e.kind === "input") {
      const key = e.data.key as { keysym?: number; pressed?: boolean } | undefined
      const mouse = e.data.mouse as { x?: number; y?: number; buttons?: number; wheel?: number } | undefined
      const clip = e.data.clipboard as { mime?: string } | undefined
      const imeText = e.data.text as string | undefined
      if (imeText) {
        // IME-committed text (输入法) lands as one string — append it to the
        // running typed-text row so 中文 shows in the audit timeline.
        if (!typing) typing = { tMs: e.tMs, text: "" }
        typing.text += imeText
        continue
      }
      if (key && key.pressed) {
        const label = keysymLabel(Number(key.keysym))
        if (label) {
          if (!typing) typing = { tMs: e.tMs, text: "" }
          typing.text += label
          continue
        }
        flush()
        continue
      }
      if (key) continue // key-up — ignore
      flush()
      if (mouse) {
        const btn = mouseButtons(Number(mouse.buttons))
        const where = `(${mouse.x ?? 0}, ${mouse.y ?? 0})`
        if (mouse.wheel) {
          rows.push({ tMs: e.tMs, kind: "滚轮", tone: "text-muted-foreground", text: `${(mouse.wheel ?? 0) > 0 ? "上" : "下"} ${where}` })
        } else {
          rows.push({ tMs: e.tMs, kind: "鼠标", tone: "text-blue-600 dark:text-blue-400", text: `${btn} ${where}` })
        }
      } else if (clip) {
        rows.push({ tMs: e.tMs, kind: "剪贴板", tone: "text-purple-600 dark:text-purple-400", text: `粘贴 ${clip.mime ?? ""}` })
      }
    } else {
      flush()
      const type = String(e.data.type ?? "")
      rows.push({ tMs: e.tMs, kind: "事件", tone: eventTextTone(type), text: describeEvent(e) })
    }
  }
  flush()
  return rows
}

function keysymLabel(keysym: number): string | null {
  if (!Number.isFinite(keysym)) return null
  if (keysym >= 0x20 && keysym <= 0x7e) return String.fromCharCode(keysym)
  const special: Record<number, string> = {
    0xff0d: "⏎",
    0xff8d: "⏎",
    0xff09: "⇥",
    0xff08: "⌫",
    0xffff: "⌦",
    0xff1b: "⎋",
    0xff51: "←",
    0xff52: "↑",
    0xff53: "→",
    0xff54: "↓",
  }
  return special[keysym] ?? null
}

function mouseButtons(mask: number): string {
  const parts: string[] = []
  if (mask & 1) parts.push("左键")
  if (mask & 2) parts.push("中键")
  if (mask & 4) parts.push("右键")
  return parts.length ? parts.join("+") : "移动"
}

function describeEvent(e: DtrTimelineEntry): string {
  const type = String(e.data.type ?? "")
  const message = e.data.message ? String(e.data.message) : ""
  const map: Record<string, string> = {
    "session-start": "会话开始",
    "session-end": "会话结束",
    "ws-detach": "断开查看",
    "status:CONNECTING": "连接中",
    "status:HANDSHAKE": "握手",
    "status:CONNECTED": "已连接",
    "status:RECONNECTING": "重连中",
    "status:CLOSED": "已关闭",
    "status:ERROR": "错误",
    "clipboard-out": "远端剪贴板",
  }
  const base = map[type] ?? type
  if (type === "session-start" && e.data.width) return `${base} ${e.data.width}×${e.data.height}`
  return message ? `${base}：${message}` : base
}

function eventTone(type: string): string {
  if (type === "status:ERROR") return "bg-destructive"
  if (type === "status:CONNECTED" || type === "session-start") return "bg-emerald-500"
  if (type === "status:RECONNECTING" || type === "status:CONNECTING") return "bg-amber-500"
  return "bg-muted-foreground/60"
}

function eventTextTone(type: string): string {
  if (type === "status:ERROR") return "text-destructive"
  if (type === "status:CONNECTED" || type === "session-start") return "text-emerald-600 dark:text-emerald-400"
  return "text-amber-600 dark:text-amber-400"
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}
