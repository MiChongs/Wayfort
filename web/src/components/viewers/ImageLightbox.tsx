"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  GalleryHorizontalEnd,
  Grid2x2,
  Info,
  Keyboard,
  Link2,
  Maximize,
  Minimize,
  Pause,
  Pencil,
  Pipette,
  Play,
  RotateCcw,
  RotateCw,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { toast } from "@/components/ui/sonner"
import { fmtBytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ExifPanel } from "./ExifPanel"
import { hasExifPotential, isRasterEditable } from "./viewerKind"

export type LightboxSlide = {
  src: string
  name: string
  title?: string
  exifUrl?: string
  ref?: string
  size?: number
}

const EASE = [0.22, 1, 0.36, 1] as const
const MIN_SCALE = 1
const MAX_SCALE = 8
const SLIDESHOW_MS = 3500
const IDLE_MS = 2600

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi)
}

type EyeDropperLike = { open: () => Promise<{ sRGBHex: string }> }
function eyeDropperCtor(): (new () => EyeDropperLike) | null {
  if (typeof window === "undefined") return null
  return (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper ?? null
}

// A self-contained, professional-grade image viewer (no third-party lightbox):
// pointer-centric wheel zoom, drag-pan, rotate + flip, fit / 1:1 / zoom presets,
// a live minimap while zoomed, an RGB+luma histogram, a system eyedropper, a
// slideshow, fullscreen with idle-fade chrome, direction-aware transitions,
// copy image / copy link, a full EXIF drawer, and a keyboard help sheet.
// Rendered into a body portal so nothing can clip it.
export function ImageLightbox({
  open,
  slides,
  index,
  onClose,
  onIndexChange,
  onEdit,
  onDownload,
}: {
  open: boolean
  slides: LightboxSlide[]
  index: number
  onClose: () => void
  onIndexChange?: (i: number) => void
  onEdit?: (slide: LightboxSlide) => void
  onDownload?: (slide: LightboxSlide) => void
}) {
  const reduce = useReducedMotion()
  const [cur, setCur] = React.useState(index)
  const [dir, setDir] = React.useState(0)
  const [scale, setScale] = React.useState(1)
  const [offset, setOffset] = React.useState({ x: 0, y: 0 })
  const [rotate, setRotate] = React.useState(0)
  const [flip, setFlip] = React.useState({ x: false, y: false })
  const [infoOpen, setInfoOpen] = React.useState(false)
  const [playing, setPlaying] = React.useState(false)
  const [fs, setFs] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  const [natural, setNatural] = React.useState({ w: 0, h: 0 })
  const [chrome, setChrome] = React.useState(true)
  const [thumbs, setThumbs] = React.useState(true)
  const [help, setHelp] = React.useState(false)
  const [histOn, setHistOn] = React.useState(false)
  const [zoomMenu, setZoomMenu] = React.useState(false)
  const [linked, setLinked] = React.useState(false)
  const [bg, setBg] = React.useState<"dark" | "checker" | "light">("dark")

  const stageRef = React.useRef<HTMLDivElement>(null)
  const imgRef = React.useRef<HTMLImageElement>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const drag = React.useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const thumbRailRef = React.useRef<HTMLDivElement>(null)
  const idle = React.useRef<number>(0)

  React.useEffect(() => {
    setCur(index)
  }, [index])

  const reset = React.useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setRotate(0)
    setFlip({ x: false, y: false })
  }, [])

  const go = React.useCallback(
    (next: number, d = 0) => {
      if (slides.length === 0) return
      const n = (next + slides.length) % slides.length
      setDir(d || (n > cur ? 1 : -1))
      setCur(n)
      setLoaded(false)
      reset()
      onIndexChange?.(n)
    },
    [slides.length, cur, reset, onIndexChange],
  )

  const zoomBy = React.useCallback((factor: number) => {
    setScale((s) => {
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      if (ns === 1) setOffset({ x: 0, y: 0 })
      return ns
    })
  }, [])

  const zoomTo = React.useCallback((target: number) => {
    setOffset({ x: 0, y: 0 })
    setScale(clamp(target, MIN_SCALE, MAX_SCALE))
    setZoomMenu(false)
  }, [])

  // 1:1 — render one image pixel per device pixel.
  const actualSize = React.useCallback(() => {
    const img = imgRef.current
    if (!img || !img.clientWidth || !natural.w) return
    setOffset({ x: 0, y: 0 })
    setScale(clamp(natural.w / img.clientWidth, MIN_SCALE, MAX_SCALE))
    setZoomMenu(false)
  }, [natural.w])

  // Idle-fade chrome (immersive). Any pointer move wakes it.
  const wake = React.useCallback(() => {
    setChrome(true)
    window.clearTimeout(idle.current)
    idle.current = window.setTimeout(() => setChrome(false), IDLE_MS)
  }, [])
  React.useEffect(() => {
    if (!open) return
    wake()
    return () => window.clearTimeout(idle.current)
  }, [open, cur, wake])

  // Keep the active thumbnail in view.
  React.useEffect(() => {
    thumbRailRef.current?.querySelector<HTMLElement>(`[data-thumb="${cur}"]`)?.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: "smooth",
    })
  }, [cur, thumbs])

  // Slideshow.
  React.useEffect(() => {
    if (!playing || !open) return
    const t = window.setInterval(() => go(cur + 1, 1), SLIDESHOW_MS)
    return () => window.clearInterval(t)
  }, [playing, open, cur, go])

  const copyImage = React.useCallback(async (s: LightboxSlide) => {
    try {
      const blob = await (await fetch(s.src)).blob()
      await navigator.clipboard.write([new window.ClipboardItem({ [blob.type]: blob })])
      toast.success("已复制图片到剪贴板")
    } catch {
      toast.error("复制失败", { description: "浏览器可能不支持复制该格式" })
    }
  }, [])

  const copyLink = React.useCallback(async (s: LightboxSlide) => {
    try {
      const abs = new URL(s.src, window.location.href).href
      await navigator.clipboard.writeText(abs)
      setLinked(true)
      window.setTimeout(() => setLinked(false), 1200)
      toast.success("已复制图片链接")
    } catch {
      toast.error("复制链接失败")
    }
  }, [])

  const pickColor = React.useCallback(async () => {
    const Ctor = eyeDropperCtor()
    if (!Ctor) return
    try {
      const { sRGBHex } = await new Ctor().open()
      await navigator.clipboard.writeText(sRGBHex).catch(() => {})
      toast.success(`取色 ${sRGBHex.toUpperCase()}`, { description: "已复制色值到剪贴板" })
    } catch {
      /* user dismissed */
    }
  }, [])

  const toggleFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen?.()
  }, [])

  // Keyboard map.
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const s = slides[cur]
      switch (e.key) {
        case "Escape":
          if (help) setHelp(false)
          else if (zoomMenu) setZoomMenu(false)
          else if (infoOpen) setInfoOpen(false)
          else onClose()
          break
        case "ArrowLeft": go(cur - 1, -1); break
        case "ArrowRight": go(cur + 1, 1); break
        case "Home": go(0, -1); break
        case "End": go(slides.length - 1, 1); break
        case "+":
        case "=": zoomBy(1.3); break
        case "-": zoomBy(1 / 1.3); break
        case "0": reset(); break
        case "1": actualSize(); break
        case "r": setRotate((v) => (v + 90) % 360); break
        case "R": setRotate((v) => (v + 270) % 360); break
        case "h": setFlip((f) => ({ ...f, x: !f.x })); break
        case "v": setFlip((f) => ({ ...f, y: !f.y })); break
        case "c": if (s) void copyImage(s); break
        case "g": setHistOn((v) => !v); break
        case "i": if (s && hasExifPotential(s.name)) setInfoOpen((v) => !v); break
        case "t": setThumbs((v) => !v); break
        case "f": toggleFullscreen(); break
        case "?": setHelp((v) => !v); break
        case " ":
          e.preventDefault()
          if (slides.length > 1) setPlaying((p) => !p)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, cur, slides, infoOpen, help, zoomMenu, go, onClose, reset, zoomBy, actualSize, copyImage, toggleFullscreen])

  React.useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === rootRef.current)
    document.addEventListener("fullscreenchange", onFs)
    return () => document.removeEventListener("fullscreenchange", onFs)
  }, [])

  const onWheel = (e: React.WheelEvent) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const cx = e.clientX - rect.left - rect.width / 2
    const cy = e.clientY - rect.top - rect.height / 2
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18
    setScale((s) => {
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      if (ns === s) return s
      if (ns === 1) {
        setOffset({ x: 0, y: 0 })
        return ns
      }
      const imgX = (cx - offset.x) / s
      const imgY = (cy - offset.y) / s
      setOffset({ x: cx - imgX * ns, y: cy - imgY * ns })
      return ns
    })
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    setOffset({ x: drag.current.ox + (e.clientX - drag.current.x), y: drag.current.oy + (e.clientY - drag.current.y) })
  }
  const onPointerUp = () => {
    drag.current = null
  }

  if (!open || typeof document === "undefined" || slides.length === 0) return null
  const slide = slides[cur]
  if (!slide) return null

  const showInfo = hasExifPotential(slide.name)
  const showEdit = isRasterEditable(slide.name) && !!onEdit
  const canPick = !!eyeDropperCtor()
  const multi = slides.length > 1
  const transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotate}deg) scaleX(${flip.x ? -1 : 1}) scaleY(${flip.y ? -1 : 1})`

  return createPortal(
    <motion.div
      ref={rootRef}
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduce ? undefined : { opacity: 0 }}
      transition={{ duration: 0.2 }}
      onPointerMove={wake}
      className="fixed inset-0 z-[120] flex flex-col bg-[#141413]/97 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={slide.name}
    >
      {/* Top toolbar */}
      <motion.div
        animate={{ opacity: chrome ? 1 : 0, y: chrome ? 0 : -8 }}
        transition={{ duration: 0.2 }}
        className={cn("flex shrink-0 items-center gap-3 px-4 py-2.5", !chrome && "pointer-events-none")}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white/95" title={slide.name}>
            {slide.title || slide.name}
          </p>
          {multi && <p className="text-xs text-white/45">{cur + 1} / {slides.length}</p>}
        </div>

        {/* Zoom cluster */}
        <div className="flex items-center gap-0.5 rounded-full bg-white/[0.06] px-1 py-0.5">
          <ToolBtn label="缩小 (-)" onClick={() => zoomBy(1 / 1.3)} icon={ZoomOut} />
          <div className="relative">
            <button
              type="button"
              onClick={() => setZoomMenu((v) => !v)}
              className="w-14 select-none rounded-md py-1 text-center text-xs tabular-nums text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              {Math.round(scale * 100)}%
            </button>
            <AnimatePresence>
              {zoomMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setZoomMenu(false)} />
                  <motion.div
                    initial={reduce ? false : { opacity: 0, y: 6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reduce ? undefined : { opacity: 0, y: 6, scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                    className="absolute left-1/2 top-9 z-50 w-28 -translate-x-1/2 overflow-hidden rounded-lg border border-white/10 bg-[#1f1e1b]/95 p-1 shadow-2xl backdrop-blur"
                  >
                    <ZoomItem label="适应屏幕" onClick={() => zoomTo(1)} />
                    <ZoomItem label="原始 1:1" onClick={actualSize} />
                    <ZoomItem label="200%" onClick={() => zoomTo(2)} />
                    <ZoomItem label="400%" onClick={() => zoomTo(4)} />
                    <ZoomItem label="最大 800%" onClick={() => zoomTo(MAX_SCALE)} />
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
          <ToolBtn label="放大 (+)" onClick={() => zoomBy(1.3)} icon={ZoomIn} />
          <ToolBtn label="原始大小 1:1 (按键 1)" onClick={actualSize} icon={Scan} />
        </div>

        {/* Transform cluster */}
        <div className="flex items-center gap-0.5 rounded-full bg-white/[0.06] px-1 py-0.5">
          <ToolBtn label="逆时针旋转 (R)" onClick={() => setRotate((v) => (v + 270) % 360)} icon={RotateCcw} />
          <ToolBtn label="顺时针旋转 (r)" onClick={() => setRotate((v) => (v + 90) % 360)} icon={RotateCw} />
          <ToolBtn label="水平翻转 (h)" active={flip.x} onClick={() => setFlip((f) => ({ ...f, x: !f.x }))} icon={FlipHorizontal2} />
          <ToolBtn label="垂直翻转 (v)" active={flip.y} onClick={() => setFlip((f) => ({ ...f, y: !f.y }))} icon={FlipVertical2} />
          <ToolBtn label="背景切换（看透明图）" active={bg !== "dark"} onClick={() => setBg((b) => (b === "dark" ? "checker" : b === "checker" ? "light" : "dark"))} icon={Grid2x2} />
        </div>

        {/* Tools cluster */}
        <div className="flex items-center gap-0.5 rounded-full bg-white/[0.06] px-1 py-0.5">
          {multi && (
            <ToolBtn label={playing ? "暂停放映" : "幻灯片放映 (空格)"} active={playing} onClick={() => setPlaying((p) => !p)} icon={playing ? Pause : Play} />
          )}
          {multi && <ToolBtn label="缩略图 (t)" active={thumbs} onClick={() => setThumbs((v) => !v)} icon={GalleryHorizontalEnd} />}
          <ToolBtn label="直方图 (g)" active={histOn} onClick={() => setHistOn((v) => !v)} icon={BarChart3} />
          {canPick && <ToolBtn label="屏幕取色" onClick={pickColor} icon={Pipette} />}
          {showInfo && <ToolBtn label="元数据 (i)" active={infoOpen} onClick={() => setInfoOpen((v) => !v)} icon={Info} />}
          <ToolBtn label="复制图片 (c)" onClick={() => void copyImage(slide)} icon={Copy} />
          <ToolBtn label="复制链接" onClick={() => void copyLink(slide)} icon={linked ? Check : Link2} />
          {showEdit && <ToolBtn label="编辑" onClick={() => onEdit?.(slide)} icon={Pencil} />}
          {onDownload && <ToolBtn label="下载" onClick={() => onDownload(slide)} icon={Download} />}
        </div>

        {/* View cluster */}
        <div className="flex items-center gap-0.5 rounded-full bg-white/[0.06] px-1 py-0.5">
          <ToolBtn label="快捷键 (?)" active={help} onClick={() => setHelp((v) => !v)} icon={Keyboard} />
          <ToolBtn label={fs ? "退出全屏 (f)" : "全屏 (f)"} onClick={toggleFullscreen} icon={fs ? Minimize : Maximize} />
          <ToolBtn label="关闭 (Esc)" onClick={onClose} icon={X} />
        </div>
      </motion.div>

      {/* Stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {multi && <NavArrow side="left" visible={chrome} onClick={() => go(cur - 1, -1)} />}

        <div
          ref={stageRef}
          className={cn(
            "relative flex h-full w-full items-center justify-center transition-colors",
            bg === "checker" &&
              "bg-[length:22px_22px] bg-[linear-gradient(45deg,rgba(255,255,255,0.07)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.07)_75%),linear-gradient(45deg,rgba(255,255,255,0.07)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.07)_75%)] bg-[position:0_0,11px_11px]",
            bg === "light" && "bg-neutral-200",
          )}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onDoubleClick={() => (scale > 1 ? reset() : setScale(2.5))}
          style={{ cursor: scale > 1 ? (drag.current ? "grabbing" : "grab") : "default" }}
        >
          {!loaded && (
            <div className="absolute h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
          )}
          <AnimatePresence custom={dir} mode="popLayout" initial={false}>
            <motion.img
              key={slide.src}
              ref={imgRef}
              custom={dir}
              src={slide.src}
              alt={slide.name}
              draggable={false}
              onLoad={(e) => {
                setLoaded(true)
                setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }}
              initial={reduce ? false : { opacity: 0, x: dir * 60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: dir * -60 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="max-h-full max-w-full select-none object-contain"
              style={{ transform, transition: drag.current ? "none" : "transform 0.12s ease-out" }}
            />
          </AnimatePresence>
        </div>

        {multi && <NavArrow side="right" visible={chrome} onClick={() => go(cur + 1, 1)} />}

        {/* Minimap (only while zoomed) */}
        <AnimatePresence>
          {scale > 1.15 && (
            <MiniMap key="mm" src={slide.src} stageEl={stageRef.current} imgEl={imgRef.current} scale={scale} offset={offset} />
          )}
        </AnimatePresence>

        {/* Histogram */}
        <AnimatePresence>
          {histOn && <Histogram key="hist" imgEl={imgRef.current} src={slide.src} ready={loaded} />}
        </AnimatePresence>
      </div>

      {/* Bottom info + zoom slider */}
      <motion.div
        animate={{ opacity: chrome ? 1 : 0, y: chrome ? 0 : 8 }}
        transition={{ duration: 0.2 }}
        className={cn("flex shrink-0 items-center gap-4 px-4 py-2 text-xs text-white/55", !chrome && "pointer-events-none")}
      >
        <span className="tabular-nums">
          {natural.w > 0 ? `${natural.w} × ${natural.h}` : "—"}
          {natural.w > 0 ? ` · ${(((natural.w * natural.h) / 1e6) || 0).toFixed(1)}MP` : ""}
          {slide.size ? ` · ${fmtBytes(slide.size)}` : ""}
        </span>
        <div className="flex flex-1 items-center justify-center gap-2">
          <ZoomOut className="h-3.5 w-3.5" />
          <Slider
            value={[scale]}
            min={MIN_SCALE}
            max={MAX_SCALE}
            step={0.05}
            onValueChange={([v]) => {
              if (v === 1) setOffset({ x: 0, y: 0 })
              setScale(v)
            }}
            className="max-w-xs"
          />
          <ZoomIn className="h-3.5 w-3.5" />
        </div>
        <span className="w-14 text-right tabular-nums">{Math.round(scale * 100)}%</span>
      </motion.div>

      {/* Thumbnail rail */}
      <AnimatePresence initial={false}>
        {multi && thumbs && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: chrome ? 1 : 0.25 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden"
          >
            <div ref={thumbRailRef} className="flex items-end gap-2 px-4 py-3 overflow-x-auto [&::-webkit-scrollbar]:hidden">
              {slides.map((s, i) => (
                <button
                  key={s.src + i}
                  data-thumb={i}
                  type="button"
                  onClick={() => go(i, i > cur ? 1 : -1)}
                  title={s.name}
                  className={cn(
                    "group/thumb relative h-14 w-14 shrink-0 overflow-hidden rounded-md ring-2 transition-all",
                    i === cur ? "ring-primary" : "ring-transparent opacity-55 hover:opacity-100",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.src} alt={s.name} loading="lazy" className="h-full w-full object-cover" />
                  {i === cur && (
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-center text-[9px] text-white/90">
                      {s.name}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* EXIF drawer */}
      <AnimatePresence>
        {infoOpen && (
          <motion.aside
            initial={reduce ? false : { x: 360, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduce ? undefined : { x: 360, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE }}
            className="absolute right-0 top-0 z-30 flex h-full w-[22rem] flex-col border-l bg-card shadow-2xl"
          >
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <span className="truncate text-sm font-medium" title={slide.name}>{slide.name}</span>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setInfoOpen(false)} aria-label="关闭元数据">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <ExifPanel url={slide.exifUrl || slide.src} name={slide.name} className="min-h-0 flex-1" />
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Keyboard help */}
      <AnimatePresence>{help && <HelpSheet key="help" onClose={() => setHelp(false)} reduce={!!reduce} />}</AnimatePresence>
    </motion.div>,
    document.body,
  )
}

function NavArrow({ side, visible, onClick }: { side: "left" | "right"; visible: boolean; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.2 }}
      aria-label={side === "left" ? "上一张" : "下一张"}
      className={cn(
        "absolute z-10 grid h-11 w-11 place-items-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20",
        side === "left" ? "left-3" : "right-3",
        !visible && "pointer-events-none",
      )}
    >
      {side === "left" ? <ChevronLeft className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
    </motion.button>
  )
}

// Live minimap: reads screen rects of the (transformed) image and the stage to
// draw a viewport box over a thumbnail. Recomputes on every zoom/pan.
function MiniMap({
  src,
  stageEl,
  imgEl,
  scale,
  offset,
}: {
  src: string
  stageEl: HTMLDivElement | null
  imgEl: HTMLImageElement | null
  scale: number
  offset: { x: number; y: number }
}) {
  const [box, setBox] = React.useState<{ l: number; t: number; w: number; h: number } | null>(null)
  React.useEffect(() => {
    if (!stageEl || !imgEl) return
    const ir = imgEl.getBoundingClientRect()
    const sr = stageEl.getBoundingClientRect()
    if (ir.width < 1 || ir.height < 1) return
    setBox({
      l: clamp((sr.left - ir.left) / ir.width, 0, 1),
      t: clamp((sr.top - ir.top) / ir.height, 0, 1),
      w: clamp(sr.width / ir.width, 0, 1),
      h: clamp(sr.height / ir.height, 0, 1),
    })
  }, [stageEl, imgEl, scale, offset])

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.18 }}
      className="absolute bottom-4 right-4 z-20 h-28 w-28 overflow-hidden rounded-lg border border-white/15 bg-black/40 shadow-xl"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="h-full w-full object-contain opacity-80" />
      {box && (
        <div
          className="pointer-events-none absolute border-2 border-primary bg-primary/10"
          style={{ left: `${box.l * 100}%`, top: `${box.t * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
        />
      )}
    </motion.div>
  )
}

// RGB + luminance histogram, computed from the loaded <img> on a downscaled
// offscreen canvas. Cross-origin (tainted) images can't be read — we surface a
// small hint instead of crashing.
function Histogram({ imgEl, src, ready }: { imgEl: HTMLImageElement | null; src: string; ready: boolean }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [tainted, setTainted] = React.useState(false)

  React.useEffect(() => {
    setTainted(false)
    if (!ready || !imgEl || !imgEl.naturalWidth) return
    const W = 256
    const ratio = imgEl.naturalHeight / imgEl.naturalWidth
    const H = Math.max(1, Math.round(W * ratio))
    const off = document.createElement("canvas")
    off.width = W
    off.height = H
    const octx = off.getContext("2d", { willReadFrequently: true })
    if (!octx) return
    let data: Uint8ClampedArray
    try {
      octx.drawImage(imgEl, 0, 0, W, H)
      data = octx.getImageData(0, 0, W, H).data
    } catch {
      setTainted(true)
      return
    }
    const r = new Float32Array(256)
    const g = new Float32Array(256)
    const b = new Float32Array(256)
    const l = new Float32Array(256)
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i], G = data[i + 1], B = data[i + 2]
      r[R]++; g[G]++; b[B]++
      l[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++
    }
    const draw = canvasRef.current
    const ctx = draw?.getContext("2d")
    if (!draw || !ctx) return
    const cw = draw.width
    const ch = draw.height
    ctx.clearRect(0, 0, cw, ch)
    const peak = Math.max(...l, ...r, ...g, ...b, 1)
    const channels: [Float32Array, string][] = [
      [r, "rgba(232,90,90,0.55)"],
      [g, "rgba(90,200,120,0.55)"],
      [b, "rgba(90,140,232,0.55)"],
      [l, "rgba(255,255,255,0.28)"],
    ]
    ctx.globalCompositeOperation = "lighter"
    for (const [arr, color] of channels) {
      ctx.beginPath()
      ctx.moveTo(0, ch)
      for (let x = 0; x < 256; x++) {
        const v = Math.pow(arr[x] / peak, 0.4)
        ctx.lineTo((x / 255) * cw, ch - v * ch)
      }
      ctx.lineTo(cw, ch)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }
    ctx.globalCompositeOperation = "source-over"
  }, [imgEl, src, ready])

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.18 }}
      className="absolute bottom-4 left-4 z-20 overflow-hidden rounded-lg border border-white/15 bg-black/55 p-2 shadow-xl backdrop-blur"
    >
      <div className="mb-1 flex items-center gap-2 px-0.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-white/55">直方图</span>
        <span className="flex items-center gap-1.5 text-[9px] text-white/40">
          <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "rgb(232,90,90)" }} />R
          <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "rgb(90,200,120)" }} />G
          <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "rgb(90,140,232)" }} />B
        </span>
      </div>
      {tainted ? (
        <div className="grid h-[80px] w-[220px] place-items-center text-center text-[10px] text-white/45">
          跨域图片无法读取像素
        </div>
      ) : (
        <canvas ref={canvasRef} width={220} height={80} className="block" />
      )}
    </motion.div>
  )
}

const SHORTCUTS: [string, string][] = [
  ["← / →", "上一张 / 下一张"],
  ["+ / −", "放大 / 缩小"],
  ["0 / 1", "适应屏幕 / 原始大小"],
  ["r / R", "顺时针 / 逆时针旋转"],
  ["h / v", "水平 / 垂直翻转"],
  ["c", "复制图片"],
  ["g", "直方图"],
  ["i", "元数据"],
  ["t", "缩略图条"],
  ["空格", "幻灯片放映"],
  ["f", "全屏"],
  ["双击", "缩放 / 复位"],
  ["Esc", "关闭"],
]

function HelpSheet({ onClose, reduce }: { onClose: () => void; reduce: boolean }) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduce ? undefined : { opacity: 0 }}
      className="absolute inset-0 z-40 grid place-items-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={reduce ? false : { scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={reduce ? undefined : { scale: 0.96, opacity: 0 }}
        transition={{ duration: 0.18, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(420px,calc(100vw-2rem))] rounded-2xl border bg-card p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-center gap-2">
          <Keyboard className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">键盘快捷键</h3>
        </div>
        <dl className="grid grid-cols-1 gap-1.5">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-3 text-sm">
              <dt className="text-muted-foreground">{d}</dt>
              <dd>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]">{k}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </motion.div>
    </motion.div>
  )
}

function ZoomItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded px-2 py-1.5 text-left text-xs text-white/75 transition-colors hover:bg-white/10 hover:text-white"
    >
      {label}
    </button>
  )
}

function ToolBtn({
  label,
  icon: Icon,
  onClick,
  active,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  active?: boolean
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn("h-9 w-9 text-white/80 hover:bg-white/10 hover:text-white", active && "bg-primary/25 text-white")}
    >
      <Icon className="h-[18px] w-[18px]" />
    </Button>
  )
}
