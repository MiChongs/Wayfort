// Framework-agnostic watermark engine built on watermark-js-plus.
//
// It mounts a diagonally-tiled, high-z, pointer-events:none identity overlay
// onto any target element and (optionally) an invisible blind watermark for
// forensic decode. The library is dynamically imported so it never lands in the
// SSR bundle or the initial chunk.
//
// Two design constraints from the library shape this code:
//  1. validateUnique() refuses a second watermark whose parent already hosts
//     one — so the visible and blind layers get separate host containers.
//  2. A non-body ("custom") parent gets an absolute, full-cover, pointer-events:
//     none dom; body/html ("root") is treated differently. We therefore always
//     mount into our own fixed/absolute host div rather than into <body> raw, so
//     positioning is predictable and we never reflow the app layout.

import type { WatermarkRuntime } from "@/lib/api/types"

export type Surface = "auto" | "light" | "dark"

export interface WatermarkEngine {
  /** Re-render the visible layer (used to advance the live clock). */
  refresh: () => void
  /** Tear everything down and restore the target. */
  destroy: () => void
}

// Sit above app content but below nothing we care about; pointer-events:none on
// every layer means it never intercepts input regardless of stacking.
const Z_VISIBLE = 2147483640
const Z_BLIND = 2147483639

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`
}

/** Replace {date}/{time}/{datetime} with the current wall-clock values. */
export function fillTimeTokens(template: string): string {
  if (!/\{(date|time|datetime)\}/.test(template)) return template
  const d = new Date()
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return template
    .replace(/\{datetime\}/g, `${date} ${time}`)
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
}

// --- colour / contrast helpers (keep the mark legible on any surface) ---

function hexLuminance(hex: string): number | null {
  let h = hex.trim().replace("#", "")
  if (h.length === 3) h = h.split("").map((c) => c + c).join("")
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  // Perceived luminance (Rec. 601) — good enough for a legibility decision.
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function surfaceLuminance(target: HTMLElement, surface: Surface): number {
  if (surface === "dark") return 0.08
  if (surface === "light") return 0.96
  // auto: the app toggles a `dark` class on <html> via next-themes.
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) return 0.1
  // walk up for a concrete background colour as a fallback signal
  let el: HTMLElement | null = target
  while (el) {
    const bg = getComputedStyle(el).backgroundColor
    const m = bg.match(/rgba?\(([^)]+)\)/)
    if (m) {
      const [r, g, b, a = 1] = m[1].split(",").map((s) => parseFloat(s))
      if (a > 0) return (0.299 * r + 0.587 * g + 0.114 * b) / 255
    }
    el = el.parentElement
  }
  return 0.96
}

/** Pick a fill colour that stays readable, plus a halo of opposite luminance. */
function effectiveColors(target: HTMLElement, configured: string, surface: Surface) {
  const bgLum = surfaceLuminance(target, surface)
  const cfgLum = hexLuminance(configured)
  let fill = configured
  // Flip only when the configured colour would vanish into the surface.
  if (cfgLum === null || Math.abs(cfgLum - bgLum) < 0.3) {
    fill = bgLum > 0.5 ? "#1a1a18" : "#ece9e3"
  }
  const fillLum = hexLuminance(fill) ?? (bgLum > 0.5 ? 0 : 1)
  const halo = fillLum > 0.5 ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.5)"
  return { fill, halo }
}

function fontFamily(): string {
  const fallback = `system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif`
  if (typeof document === "undefined") return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-sans").trim()
  return v ? `${v}, ${fallback}` : fallback
}

function makeHost(rooted: boolean, z: number): HTMLDivElement {
  const d = document.createElement("div")
  d.setAttribute("data-watermark-host", "")
  d.style.cssText = `position:${rooted ? "fixed" : "absolute"};inset:0;pointer-events:none;z-index:${z};`
  return d
}

/**
 * Mount a watermark onto `target`. Returns null on the server or if the library
 * fails to load. Always pair with engine.destroy() on teardown.
 */
export async function mountWatermark(
  target: HTMLElement,
  runtime: WatermarkRuntime,
  surface: Surface = "auto",
): Promise<WatermarkEngine | null> {
  if (typeof window === "undefined" || !runtime.enabled || !runtime.style || !runtime.text) return null

  const { Watermark, BlindWatermark } = await import("watermark-js-plus")
  const style = runtime.style
  const features = runtime.features
  const rooted = target === document.body || target === document.documentElement

  // Ensure absolute hosts have a positioned ancestor on non-root targets.
  let restorePos: (() => void) | null = null
  if (!rooted && getComputedStyle(target).position === "static") {
    const prev = target.style.position
    target.style.position = "relative"
    restorePos = () => {
      target.style.position = prev
    }
  }

  const { fill, halo } = effectiveColors(target, style.color, surface)
  const family = fontFamily()
  const buildContent = () => fillTimeTokens(runtime.text ?? "")

  const visibleHost = makeHost(rooted, Z_VISIBLE)
  target.appendChild(visibleHost)

  const visible = new Watermark({
    parent: visibleHost,
    contentType: "multi-line-text",
    content: buildContent(),
    rotate: style.rotation,
    width: Math.max(80, style.gapX),
    height: Math.max(60, style.gapY),
    fontSize: `${style.fontSize}px`,
    fontFamily: family,
    fontColor: fill,
    fontWeight: "500",
    lineHeight: Math.round(style.fontSize * 1.45),
    textAlign: "center",
    textBaseline: "middle",
    globalAlpha: clamp(style.opacity / 100, 0.02, 1),
    zIndex: Z_VISIBLE,
    shadowStyle: { shadowColor: halo, shadowBlur: 3, shadowOffsetX: 0, shadowOffsetY: 0 },
    mutationObserve: !!features?.antiTamper,
    monitorProtection: !!features?.hardened,
    movable: false,
  })
  await visible.create()

  let blind: { destroy: () => void } | null = null
  let blindHost: HTMLDivElement | null = null
  if (runtime.blind?.enabled && runtime.blind.text) {
    blindHost = makeHost(rooted, Z_BLIND)
    target.appendChild(blindHost)
    const bw = new BlindWatermark({
      parent: blindHost,
      contentType: "text",
      content: runtime.blind.text,
      rotate: style.rotation,
      width: Math.max(220, style.gapX),
      height: Math.max(180, style.gapY),
      fontSize: `${Math.max(18, style.fontSize)}px`,
      fontColor: "#000000",
      fontFamily: family,
      zIndex: Z_BLIND,
    })
    await bw.create()
    blind = bw
  }

  let timer: number | null = null
  if (features?.liveClock && /\{(date|time|datetime)\}/.test(runtime.text)) {
    const ms = clamp(features.refreshSec || 60, 10, 600) * 1000
    timer = window.setInterval(() => {
      // "append" merges content into existing props; "overwrite" would wipe the
      // style and re-default everything (see initConfigData in the library).
      void visible.changeOptions({ content: buildContent() }, "append", true).catch(() => {})
    }, ms)
  }

  return {
    refresh: () => {
      void visible.changeOptions({ content: buildContent() }, "append", true).catch(() => {})
    },
    destroy: () => {
      if (timer) window.clearInterval(timer)
      try {
        visible.destroy()
      } catch {
        /* already gone */
      }
      try {
        blind?.destroy()
      } catch {
        /* already gone */
      }
      visibleHost.remove()
      blindHost?.remove()
      restorePos?.()
    },
  }
}
