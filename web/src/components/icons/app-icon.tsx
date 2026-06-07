"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { resolveIcon } from "@/lib/icons"
import { defaultTagColor, tagColorStyle } from "@/lib/tags/palette"

// AppIcon — the universal icon renderer. Give it a unified token and it draws
// the right glyph from any supported library:
//   lucide → line icon · simple → brand glyph (brand colour, or mono) ·
//   emoji → glyph · text → tinted initials tile.
// Falls back gracefully (to `fallback`, default a box) when a token can't be
// resolved. Used everywhere a tag / node / agent shows an icon.
export function AppIcon({
  icon,
  size = 16,
  className,
  mono = false,
  fallback = "lucide:box",
  title,
}: {
  icon?: string | null
  /** Pixel size for the glyph box. Sizing also flows to emoji/text tiles. */
  size?: number
  className?: string
  /** Render brand (simple) icons in currentColor instead of their brand colour. */
  mono?: boolean
  /** Token used when `icon` can't be resolved. */
  fallback?: string
  title?: string
}) {
  const resolved = resolveIcon(icon) ?? resolveIcon(fallback)
  if (!resolved) return null

  if (resolved.kind === "lucide") {
    const Comp = resolved.Comp
    return <Comp width={size} height={size} className={className} aria-label={title} />
  }

  if (resolved.kind === "simple") {
    return (
      <svg
        role="img"
        aria-label={title ?? resolved.title}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={className}
        fill={mono ? "currentColor" : `#${resolved.hex}`}
      >
        <path d={resolved.path} />
      </svg>
    )
  }

  if (resolved.kind === "emoji") {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center leading-none", className)}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.92) }}
        aria-label={title}
        role="img"
      >
        {resolved.char}
      </span>
    )
  }

  // text → a deterministic tinted tile with 1–2 initials (avatar-style).
  const token = defaultTagColor(resolved.text)
  const style = tagColorStyle(token)
  return (
    <span
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-md font-semibold uppercase",
        style.soft,
        style.text,
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
      aria-label={title ?? resolved.text}
    >
      {resolved.text}
    </span>
  )
}
