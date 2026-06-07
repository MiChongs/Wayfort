"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileAudio,
  FileVideo,
  Gauge,
  ListVideo,
  Loader2,
  Maximize,
  Minimize,
  Music,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  Repeat1,
  RotateCw,
  Scissors,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { fmtBytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import { toast } from "@/components/ui/sonner"

export type MediaItem = { name: string; url: string; kind: "video" | "audio"; size?: number }

const MIME: Record<string, string> = {
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", aac: "audio/aac",
  m4a: "audio/mp4", opus: "audio/ogg", weba: "audio/webm",
}
function mimeFor(name: string, kind: "video" | "audio"): string {
  const ext = name.split(".").pop()?.toLowerCase() || ""
  return MIME[ext] || (kind === "video" ? "video/mp4" : "audio/mpeg")
}
function fmtTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00"
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`
}
const EASE = [0.22, 1, 0.36, 1] as const
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const IDLE_MS = 2800
type LoopMode = "off" | "one" | "all"

// A fully custom media panel — no third-party player chrome. The native
// <video> element drives playback (it handles audio files too); everything on
// top is bespoke: a scrub bar with buffered ranges + A–B region + hover-time,
// a glass transport with volume / speed / loop / PiP / fullscreen, an immersive
// idle-fade for video, an album card with a live spectrum for audio, frame
// capture, an internal playlist, persisted volume, and a full keyboard map.
export function MediaViewer({
  url,
  name,
  kind,
  playlist,
  index = 0,
  onIndexChange,
  onDownload,
}: {
  url: string
  name: string
  kind: "video" | "audio"
  playlist?: MediaItem[]
  index?: number
  onIndexChange?: (i: number) => void
  onDownload?: (item: MediaItem) => void
}) {
  const reduce = useReducedMotion()
  const rootRef = React.useRef<HTMLDivElement>(null)
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const vizRef = React.useRef<HTMLCanvasElement>(null)
  const rafRef = React.useRef<number>(0)
  const audioCtxRef = React.useRef<AudioContext | null>(null)
  const analyserRef = React.useRef<AnalyserNode | null>(null)

  const items = React.useMemo<MediaItem[]>(
    () => (playlist && playlist.length ? playlist : [{ name, url, kind }]),
    [playlist, name, url, kind],
  )
  const [cur, setCur] = React.useState(index)
  React.useEffect(() => setCur(index), [index])
  const active = items[Math.min(Math.max(0, cur), items.length - 1)] || items[0]
  const list = items.length > 1 ? items : null
  const goTo = React.useCallback(
    (i: number) => {
      const n = Math.min(Math.max(0, i), items.length - 1)
      setCur(n)
      onIndexChange?.(n)
    },
    [items.length, onIndexChange],
  )

  // ----- transport state -----
  const [ready, setReady] = React.useState(false)
  const [playing, setPlaying] = React.useState(false)
  const [waiting, setWaiting] = React.useState(false)
  const [time, setTime] = React.useState(0)
  const [duration, setDuration] = React.useState(0)
  const [buffered, setBuffered] = React.useState(0)
  const [volume, setVolume] = React.useState(1)
  const [muted, setMuted] = React.useState(false)
  const [rate, setRate] = React.useState(1)
  const [rotate, setRotate] = React.useState(0)
  const [pip, setPip] = React.useState(false)
  const [fs, setFs] = React.useState(false)
  const [ab, setAb] = React.useState<{ a: number | null; b: number | null }>({ a: null, b: null })
  const [loop, setLoop] = React.useState<LoopMode>("off")
  const [listOpen, setListOpen] = React.useState(false)
  const [rateOpen, setRateOpen] = React.useState(false)
  const [chrome, setChrome] = React.useState(true)
  const idle = React.useRef<number>(0)

  const loopRef = React.useRef(loop)
  loopRef.current = loop
  const abRef = React.useRef(ab)
  abRef.current = ab
  const itemsLenRef = React.useRef(items.length)
  itemsLenRef.current = items.length

  const isAudio = active.kind === "audio"

  const wake = React.useCallback(() => {
    setChrome(true)
    window.clearTimeout(idle.current)
    idle.current = window.setTimeout(() => setChrome(false), IDLE_MS)
  }, [])
  // Keep chrome up whenever paused or a menu is open.
  const chromeVisible = chrome || !playing || listOpen || rateOpen

  // ----- source switching -----
  React.useEffect(() => {
    const v = videoRef.current
    if (!v) return
    setReady(false)
    setTime(0)
    setDuration(0)
    setBuffered(0)
    setRotate(0)
    setAb({ a: null, b: null })
    v.src = active.url
    v.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.url])

  // ----- media element events (bound once) -----
  React.useEffect(() => {
    const v = videoRef.current
    if (!v) return

    const saved = Number(window.localStorage.getItem("media:volume") || "")
    if (Number.isFinite(saved) && saved >= 0 && saved <= 1) {
      v.volume = saved
      setVolume(saved)
    }
    const savedRate = Number(window.localStorage.getItem("media:rate") || "")
    if (Number.isFinite(savedRate) && RATES.includes(savedRate)) {
      v.playbackRate = savedRate
      setRate(savedRate)
    }

    const onLoaded = () => {
      setReady(true)
      setDuration(v.duration || 0)
    }
    const onTime = () => {
      const t = v.currentTime
      setTime(t)
      // A–B loop enforcement.
      const { a, b } = abRef.current
      if (a != null && b != null && b > a && (t >= b || t < a)) v.currentTime = a
      // Track the buffered range covering the playhead.
      try {
        for (let i = 0; i < v.buffered.length; i++) {
          if (t >= v.buffered.start(i) && t <= v.buffered.end(i) + 0.25) {
            setBuffered(v.buffered.end(i))
            break
          }
        }
      } catch {
        /* buffered can throw before metadata */
      }
    }
    const onDur = () => setDuration(v.duration || 0)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onWaiting = () => setWaiting(true)
    const onPlaying = () => setWaiting(false)
    const onVol = () => {
      setVolume(v.volume)
      setMuted(v.muted)
      window.localStorage.setItem("media:volume", String(v.volume))
    }
    const onRate = () => setRate(v.playbackRate)
    const onEnded = () => {
      if (loopRef.current === "one") {
        v.currentTime = 0
        void v.play()
        return
      }
      setCur((i) => {
        if (i < itemsLenRef.current - 1) return i + 1
        if (loopRef.current === "all") return 0
        return i
      })
    }
    const onEnterPip = () => setPip(true)
    const onLeavePip = () => setPip(false)

    v.addEventListener("loadedmetadata", onLoaded)
    v.addEventListener("timeupdate", onTime)
    v.addEventListener("progress", onTime)
    v.addEventListener("durationchange", onDur)
    v.addEventListener("play", onPlay)
    v.addEventListener("pause", onPause)
    v.addEventListener("waiting", onWaiting)
    v.addEventListener("playing", onPlaying)
    v.addEventListener("volumechange", onVol)
    v.addEventListener("ratechange", onRate)
    v.addEventListener("ended", onEnded)
    v.addEventListener("enterpictureinpicture", onEnterPip)
    v.addEventListener("leavepictureinpicture", onLeavePip)
    return () => {
      v.removeEventListener("loadedmetadata", onLoaded)
      v.removeEventListener("timeupdate", onTime)
      v.removeEventListener("progress", onTime)
      v.removeEventListener("durationchange", onDur)
      v.removeEventListener("play", onPlay)
      v.removeEventListener("pause", onPause)
      v.removeEventListener("waiting", onWaiting)
      v.removeEventListener("playing", onPlaying)
      v.removeEventListener("volumechange", onVol)
      v.removeEventListener("ratechange", onRate)
      v.removeEventListener("ended", onEnded)
      v.removeEventListener("enterpictureinpicture", onEnterPip)
      v.removeEventListener("leavepictureinpicture", onLeavePip)
    }
  }, [])

  // ----- cleanup -----
  React.useEffect(() => {
    return () => {
      window.cancelAnimationFrame(rafRef.current)
      void audioCtxRef.current?.close()
    }
  }, [])

  // ----- audio spectrum -----
  React.useEffect(() => {
    if (!isAudio) return
    const v = videoRef.current
    const canvas = vizRef.current
    if (!v || !canvas) return

    const ensureGraph = () => {
      if (analyserRef.current) {
        void audioCtxRef.current?.resume()
        return
      }
      try {
        const Ctor =
          window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new Ctor()
        audioCtxRef.current = ctx
        const srcNode = ctx.createMediaElementSource(v)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.82
        srcNode.connect(analyser)
        analyser.connect(ctx.destination)
        analyserRef.current = analyser
        draw()
      } catch {
        /* createMediaElementSource is one-shot per element; ignore re-entry */
      }
    }
    const draw = () => {
      const a = analyserRef.current
      const c = canvas.getContext("2d")
      if (!a || !c) return
      const bins = a.frequencyBinCount
      const data = new Uint8Array(bins)
      a.getByteFrequencyData(data)
      const { width, height } = canvas
      c.clearRect(0, 0, width, height)
      const n = 56
      const step = Math.floor(bins / n) || 1
      const bw = width / n
      for (let i = 0; i < n; i++) {
        let sum = 0
        for (let j = 0; j < step; j++) sum += data[i * step + j] || 0
        const v01 = sum / step / 255
        const h = Math.max(2, Math.pow(v01, 1.3) * height)
        const grad = c.createLinearGradient(0, height, 0, height - h)
        grad.addColorStop(0, "rgba(204,120,92,0.30)")
        grad.addColorStop(1, "rgba(232,165,90,0.95)")
        c.fillStyle = grad
        const x = i * bw + bw * 0.18
        c.beginPath()
        c.roundRect(x, height - h, bw * 0.64, h, 2)
        c.fill()
      }
      rafRef.current = window.requestAnimationFrame(draw)
    }
    v.addEventListener("play", ensureGraph)
    // If already playing (e.g. track switch) kick the loop.
    if (!v.paused) ensureGraph()
    return () => {
      window.cancelAnimationFrame(rafRef.current)
      v.removeEventListener("play", ensureGraph)
    }
  }, [isAudio, active.url])

  // ----- actions -----
  const togglePlay = React.useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play()
    else v.pause()
  }, [])
  const seek = React.useCallback((t: number) => {
    const v = videoRef.current
    if (v) v.currentTime = Math.max(0, Math.min(t, v.duration || t))
  }, [])
  const nudge = React.useCallback((d: number) => {
    const v = videoRef.current
    if (v) v.currentTime = Math.max(0, Math.min((v.currentTime || 0) + d, v.duration || Infinity))
  }, [])
  const setVol = React.useCallback((val: number) => {
    const v = videoRef.current
    if (!v) return
    v.volume = Math.max(0, Math.min(1, val))
    if (v.muted && val > 0) v.muted = false
  }, [])
  const toggleMute = React.useCallback(() => {
    const v = videoRef.current
    if (v) v.muted = !v.muted
  }, [])
  const applyRate = React.useCallback((r: number) => {
    const v = videoRef.current
    if (v) v.playbackRate = r
    window.localStorage.setItem("media:rate", String(r))
    setRateOpen(false)
  }, [])
  const togglePip = React.useCallback(async () => {
    const v = videoRef.current
    if (!v) return
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await v.requestPictureInPicture()
    } catch {
      toast.error("画中画不可用")
    }
  }, [])
  const toggleFs = React.useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen?.()
  }, [])
  const screenshot = React.useCallback(() => {
    const v = videoRef.current
    if (!v || !v.videoWidth) {
      toast.error("无法截图", { description: "请先开始播放视频" })
      return
    }
    const canvas = document.createElement("canvas")
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext("2d")?.drawImage(v, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `${active.name.replace(/\.[^.]+$/, "")}_${Math.floor(v.currentTime)}s.png`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success("已保存当前帧")
    }, "image/png")
  }, [active.name])
  const setAbPoint = (which: "a" | "b") => setAb((c) => ({ ...c, [which]: videoRef.current?.currentTime ?? 0 }))
  const cycleLoop = () => setLoop((m) => (m === "off" ? "all" : m === "all" ? "one" : "off"))

  React.useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === rootRef.current)
    document.addEventListener("fullscreenchange", onFs)
    return () => document.removeEventListener("fullscreenchange", onFs)
  }, [])

  React.useEffect(() => {
    wake()
    return () => window.clearTimeout(idle.current)
  }, [wake, active.url])

  // ----- keyboard -----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      wake()
      switch (e.key) {
        case " ":
        case "k": e.preventDefault(); togglePlay(); break
        case "ArrowLeft": nudge(-5); break
        case "ArrowRight": nudge(5); break
        case "j": nudge(-10); break
        case "l": nudge(10); break
        case "ArrowUp": e.preventDefault(); setVol((videoRef.current?.volume ?? 0) + 0.05); break
        case "ArrowDown": e.preventDefault(); setVol((videoRef.current?.volume ?? 0) - 0.05); break
        case "m": toggleMute(); break
        case "f": toggleFs(); break
        case "p": if (!isAudio) void togglePip(); break
        case "n": if (cur < items.length - 1) goTo(cur + 1); break
        case "b": if (cur > 0) goTo(cur - 1); break
        case "<": applyRate(RATES[Math.max(0, RATES.indexOf(rate) - 1)]); break
        case ">": applyRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(rate) + 1)]); break
        case "0": case "1": case "2": case "3": case "4": case "5": case "6": case "7": case "8": case "9":
          if (duration) seek((Number(e.key) / 10) * duration)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [cur, items.length, goTo, isAudio, rate, duration, wake, togglePlay, nudge, setVol, toggleMute, toggleFs, togglePip, applyRate, seek])

  const atFirst = cur <= 0
  const atLast = cur >= items.length - 1
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[#141413]"
      onPointerMove={wake}
      onMouseLeave={() => playing && setChrome(false)}
    >
      {/* Ambient glow for audio */}
      {isAudio && (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_55%_at_50%_36%,rgba(204,120,92,0.14),transparent_70%)]" />
      )}

      {/* Top bar */}
      <motion.div
        animate={{ opacity: chromeVisible ? 1 : 0, y: chromeVisible ? 0 : -8 }}
        transition={{ duration: 0.2 }}
        className={cn(
          "absolute inset-x-0 top-0 z-20 flex items-center gap-2 px-4 py-2.5 pr-12",
          isAudio ? "bg-transparent" : "bg-gradient-to-b from-black/70 to-transparent",
          !chromeVisible && "pointer-events-none",
        )}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-white/10 text-white/80">
          {isAudio ? <FileAudio className="h-4 w-4" /> : <FileVideo className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white/95" title={active.name}>{active.name}</p>
          {list && <p className="text-[11px] text-white/45">{cur + 1} / {list.length} · 播放列表</p>}
        </div>
        {list && <MBtn label="播放列表" icon={ListVideo} active={listOpen} onClick={() => setListOpen((v) => !v)} />}
        {onDownload && <MBtn label="下载" icon={Download} onClick={() => onDownload(active)} />}
      </motion.div>

      {list && (
        <>
          <NavArrow side="left" visible={chromeVisible && !atFirst} onClick={() => goTo(cur - 1)} />
          <NavArrow side="right" visible={chromeVisible && !atLast} onClick={() => goTo(cur + 1)} />
        </>
      )}

      {/* Stage */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-4 py-6">
        {isAudio && (
          <>
            <div className="relative grid h-40 w-40 place-items-center rounded-[32px] bg-gradient-to-br from-primary/35 to-primary/[0.05] ring-1 ring-white/10">
              <Music className="h-16 w-16 text-primary/90" />
              {playing && (
                <>
                  <motion.span
                    className="absolute inset-0 rounded-[32px] ring-2 ring-primary/40"
                    animate={{ opacity: [0.55, 0, 0.55], scale: [1, 1.1, 1] }}
                    transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                  />
                  <motion.span
                    className="absolute inset-0 rounded-[32px] ring ring-primary/30"
                    animate={{ opacity: [0.4, 0, 0.4], scale: [1, 1.18, 1] }}
                    transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
                  />
                </>
              )}
            </div>
            <div className="max-w-md text-center">
              <p className="truncate text-base font-medium text-white">{active.name}</p>
              <p className="mt-0.5 text-xs text-white/40">音频{active.size != null ? ` · ${fmtBytes(active.size)}` : ""}</p>
            </div>
            <canvas ref={vizRef} width={560} height={120} className="h-[120px] w-full max-w-md rounded-xl bg-white/[0.03] ring-1 ring-white/5" />
          </>
        )}

        {/* The element drives both modes; it's just visually parked for audio. */}
        <div
          className={cn("relative w-full transition-transform", isAudio ? "pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0" : "flex max-w-5xl items-center justify-center")}
          style={{ transform: isAudio ? undefined : `rotate(${rotate}deg)` }}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            playsInline
            onClick={togglePlay}
            onDoubleClick={toggleFs}
            className="max-h-full w-full rounded-lg bg-black object-contain"
            style={{ maxHeight: "calc(90vh - 9rem)" }}
          />
          {!isAudio && ready && !playing && (
            <button
              type="button"
              onClick={togglePlay}
              aria-label="播放"
              className="absolute inset-0 z-10 grid place-items-center"
            >
              <span className="grid h-16 w-16 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition-transform hover:scale-105">
                <Play className="h-7 w-7 translate-x-0.5" />
              </span>
            </button>
          )}
          {!isAudio && (waiting || !ready) && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
              <Loader2 className="h-9 w-9 animate-spin text-white/70" />
            </div>
          )}
        </div>
      </div>

      {/* Bottom transport */}
      <motion.div
        animate={{ opacity: chromeVisible ? 1 : 0, y: chromeVisible ? 0 : 12 }}
        transition={{ duration: 0.2 }}
        className={cn(
          "relative z-20 shrink-0 px-3 pb-3 pt-6",
          isAudio ? "" : "bg-gradient-to-t from-black/75 via-black/35 to-transparent",
          !chromeVisible && "pointer-events-none",
        )}
      >
        <SeekBar duration={duration} time={time} buffered={buffered} ab={ab} onSeek={seek} />

        <div className="mt-2 flex items-center gap-1">
          <MBtn label={playing ? "暂停 (空格)" : "播放 (空格)"} icon={playing ? Pause : Play} onClick={togglePlay} />
          {list && <MBtn label="上一个 (b)" icon={SkipBack} onClick={() => goTo(cur - 1)} disabled={atFirst} />}
          {list && <MBtn label="下一个 (n)" icon={SkipForward} onClick={() => goTo(cur + 1)} disabled={atLast} />}

          <div className="group/vol flex items-center">
            <MBtn label={muted ? "取消静音 (m)" : "静音 (m)"} icon={VolIcon} onClick={toggleMute} />
            <div className="flex w-0 items-center overflow-hidden transition-all duration-200 group-hover/vol:w-20 group-hover/vol:pr-2">
              <RangeBar
                value={muted ? 0 : volume}
                onChange={setVol}
                ariaLabel="音量"
                className="w-20"
              />
            </div>
          </div>

          <span className="ml-1 select-none text-xs tabular-nums text-white/70">
            {fmtTime(time)} <span className="text-white/35">/ {fmtTime(duration)}</span>
          </span>

          <div className="ml-auto flex items-center gap-1">
            {/* A–B loop */}
            <div className="hidden items-center gap-0.5 rounded-full bg-white/[0.06] px-1 sm:flex">
              <Scissors className="ml-1 h-3 w-3 text-white/40" />
              <button
                type="button"
                onClick={() => setAbPoint("a")}
                className={cn("rounded-full px-1.5 py-1 text-[11px] tabular-nums transition-colors hover:bg-white/10", ab.a != null ? "text-primary" : "text-white/60")}
              >
                A{ab.a != null ? `·${fmtTime(ab.a)}` : ""}
              </button>
              <button
                type="button"
                onClick={() => setAbPoint("b")}
                className={cn("rounded-full px-1.5 py-1 text-[11px] tabular-nums transition-colors hover:bg-white/10", ab.b != null ? "text-primary" : "text-white/60")}
              >
                B{ab.b != null ? `·${fmtTime(ab.b)}` : ""}
              </button>
              {(ab.a != null || ab.b != null) && (
                <button type="button" onClick={() => setAb({ a: null, b: null })} className="rounded-full px-1.5 py-1 text-[11px] text-white/40 hover:bg-white/10 hover:text-white">清</button>
              )}
            </div>

            <MBtn
              label={loop === "off" ? "循环：关" : loop === "one" ? "循环：单曲" : "循环：列表"}
              icon={loop === "one" ? Repeat1 : Repeat}
              active={loop !== "off"}
              onClick={cycleLoop}
            />

            {/* Speed */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setRateOpen((v) => !v)}
                title="播放速度"
                className={cn(
                  "flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium tabular-nums text-white/80 transition-colors hover:bg-white/10",
                  (rateOpen || rate !== 1) && "text-primary",
                )}
              >
                <Gauge className="h-4 w-4" /> {rate}×
              </button>
              <AnimatePresence>
                {rateOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setRateOpen(false)} />
                    <motion.div
                      initial={reduce ? false : { opacity: 0, y: 6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={reduce ? undefined : { opacity: 0, y: 6, scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                      className="absolute bottom-10 right-0 z-40 w-24 overflow-hidden rounded-lg border border-white/10 bg-[#1f1e1b]/95 p-1 shadow-2xl backdrop-blur"
                    >
                      {RATES.map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => applyRate(r)}
                          className={cn(
                            "flex w-full items-center justify-between rounded px-2 py-1.5 text-xs tabular-nums transition-colors hover:bg-white/10",
                            r === rate ? "text-primary" : "text-white/75",
                          )}
                        >
                          {r}× {r === rate && <Check className="h-3 w-3" />}
                        </button>
                      ))}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            {!isAudio && <MBtn label="旋转画面" icon={RotateCw} onClick={() => setRotate((r) => (r + 90) % 360)} />}
            {!isAudio && <MBtn label="截取当前帧" icon={Camera} onClick={screenshot} />}
            {!isAudio && document.pictureInPictureEnabled && (
              <MBtn label="画中画 (p)" icon={PictureInPicture2} active={pip} onClick={togglePip} />
            )}
            <MBtn label={fs ? "退出全屏 (f)" : "全屏 (f)"} icon={fs ? Minimize : Maximize} onClick={toggleFs} />
          </div>
        </div>
      </motion.div>

      {/* Playlist drawer */}
      <AnimatePresence>
        {list && listOpen && (
          <motion.aside
            initial={reduce ? false : { x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduce ? undefined : { x: 300, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="absolute right-0 top-0 z-30 flex h-full w-72 flex-col border-l border-white/10 bg-[#1f1e1b]/95 shadow-2xl backdrop-blur"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
              <span className="text-sm font-medium text-white/90">播放列表 · {list.length}</span>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-white/70 hover:bg-white/10 hover:text-white" onClick={() => setListOpen(false)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
              {list.map((m, i) => (
                <button
                  key={m.url}
                  type="button"
                  onClick={() => goTo(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                    i === cur ? "bg-primary/20 text-white ring-1 ring-primary/30" : "text-white/70 hover:bg-white/10",
                  )}
                >
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md", i === cur ? "bg-primary/30" : "bg-white/10")}>
                    {m.kind === "video" ? <FileVideo className="h-4 w-4" /> : <FileAudio className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.name}</span>
                    {m.size != null && <span className="block text-[11px] text-white/40">{fmtBytes(m.size)}</span>}
                  </span>
                  {i === cur && playing && <span className="mr-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />}
                </button>
              ))}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}

/* --------------------------------------------------------------- seek bar -- */

function SeekBar({
  duration,
  time,
  buffered,
  ab,
  onSeek,
}: {
  duration: number
  time: number
  buffered: number
  ab: { a: number | null; b: number | null }
  onSeek: (t: number) => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [hover, setHover] = React.useState<number | null>(null)
  const [dragging, setDragging] = React.useState(false)

  const frac = (clientX: number): number => {
    const el = ref.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  const pct = (t: number) => (duration > 0 ? `${Math.max(0, Math.min(1, t / duration)) * 100}%` : "0%")

  const onDown = (e: React.PointerEvent) => {
    if (!duration) return
    setDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onSeek(frac(e.clientX) * duration)
  }
  const onMove = (e: React.PointerEvent) => {
    const f = frac(e.clientX)
    setHover(f * duration)
    if (dragging) onSeek(f * duration)
  }
  const onUp = (e: React.PointerEvent) => {
    setDragging(false)
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  const aPct = ab.a != null && duration ? (ab.a / duration) * 100 : null
  const bPct = ab.b != null && duration ? (ab.b / duration) * 100 : null

  return (
    <div
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => setHover(null)}
      className="group/seek relative flex h-4 cursor-pointer items-center"
    >
      {/* track */}
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/15 transition-all group-hover/seek:h-1.5">
        <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: pct(buffered) }} />
        {/* A–B region */}
        {aPct != null && bPct != null && bPct > aPct && (
          <div className="absolute inset-y-0 bg-primary/30" style={{ left: `${aPct}%`, width: `${bPct - aPct}%` }} />
        )}
        <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: pct(time) }} />
      </div>
      {/* A / B ticks */}
      {aPct != null && <span className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded bg-primary" style={{ left: `${aPct}%` }} />}
      {bPct != null && <span className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded bg-primary" style={{ left: `${bPct}%` }} />}
      {/* thumb */}
      <span
        className={cn(
          "pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow transition-transform",
          dragging ? "scale-110" : "scale-0 group-hover/seek:scale-100",
        )}
        style={{ left: pct(time) }}
      />
      {/* hover time tooltip */}
      {hover != null && duration > 0 && (
        <span
          className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-black/85 px-1.5 py-0.5 text-[11px] tabular-nums text-white shadow"
          style={{ left: `${(hover / duration) * 100}%` }}
        >
          {fmtTime(hover)}
        </span>
      )}
    </div>
  )
}

// A compact draggable bar for volume — same visual language as the seek bar.
function RangeBar({
  value,
  onChange,
  ariaLabel,
  className,
}: {
  value: number
  onChange: (v: number) => void
  ariaLabel: string
  className?: string
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = React.useState(false)
  const frac = (clientX: number) => {
    const el = ref.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }
  return (
    <div
      ref={ref}
      role="slider"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={(e) => {
        setDragging(true)
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        onChange(frac(e.clientX))
      }}
      onPointerMove={(e) => dragging && onChange(frac(e.clientX))}
      onPointerUp={(e) => {
        setDragging(false)
        ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      }}
      className={cn("group/range relative flex h-4 cursor-pointer items-center", className)}
    >
      <div className="h-1 w-full overflow-hidden rounded-full bg-white/20">
        <div className="h-full rounded-full bg-white/80" style={{ width: `${value * 100}%` }} />
      </div>
      <span
        className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
        style={{ left: `${value * 100}%` }}
      />
    </div>
  )
}

function MBtn({
  label,
  icon: Icon,
  onClick,
  active,
  disabled,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  active?: boolean
  disabled?: boolean
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-8 w-8 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-30",
        active && "bg-primary/25 text-white",
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </Button>
  )
}

function NavArrow({ side, visible, onClick }: { side: "left" | "right"; visible: boolean; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.2 }}
      aria-label={side === "left" ? "上一个" : "下一个"}
      className={cn(
        "absolute top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20",
        side === "left" ? "left-3" : "right-3",
        !visible && "pointer-events-none",
      )}
    >
      {side === "left" ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
    </motion.button>
  )
}
