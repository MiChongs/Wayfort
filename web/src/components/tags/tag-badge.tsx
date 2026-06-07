"use client"

import * as React from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { resolveTagColor } from "@/lib/tags/palette"
import { AppIcon } from "@/components/icons/app-icon"
import type { AssetTag } from "@/lib/api/types"

// A single managed tag rendered as a colourful pill: optional emoji, name, and
// (when interactive) a remove affordance. Colour comes from the tag's palette
// token via resolveTagColor, with a legacy-hex inline fallback. This is THE
// canonical way to show a tag — node cards, the picker, the admin page all use
// it so a tag looks identical everywhere.

export interface TagBadgeProps {
  tag: Pick<AssetTag, "name" | "color" | "icon">
  size?: "xs" | "sm" | "md"
  /** Render a leading solid dot instead of (or alongside) the emoji. */
  showDot?: boolean
  /** Show the × button + call this on click. */
  onRemove?: () => void
  /** Hover/press affordances for clickable chips (picker rows, facets). */
  interactive?: boolean
  /** Dim to a "not selected" look (facets / multi-select). */
  muted?: boolean
  className?: string
  title?: string
  onClick?: () => void
}

const SIZE: Record<NonNullable<TagBadgeProps["size"]>, string> = {
  xs: "h-5 gap-1 px-1.5 text-[11px]",
  sm: "h-6 gap-1 px-2 text-xs",
  md: "h-7 gap-1.5 px-2.5 text-sm",
}

const ICON_PX: Record<NonNullable<TagBadgeProps["size"]>, number> = { xs: 12, sm: 13, md: 15 }

export const TagBadge = React.memo(function TagBadge({
  tag,
  size = "sm",
  showDot = false,
  onRemove,
  interactive = false,
  muted = false,
  className,
  title,
  onClick,
}: TagBadgeProps) {
  const c = resolveTagColor(tag.color, tag.name)
  const hasIcon = !!tag.icon?.trim()

  return (
    <span
      onClick={onClick}
      title={title ?? tag.name}
      style={muted ? undefined : c.inline?.chip}
      className={cn(
        "inline-flex max-w-full items-center rounded-full border font-medium leading-none transition-colors",
        SIZE[size],
        muted
          ? "border-border/70 bg-transparent text-muted-foreground"
          : !c.inline && c.style.chip,
        interactive && "cursor-pointer hover:brightness-105 active:scale-[0.98]",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {showDot && !hasIcon && (
        <span
          aria-hidden
          style={muted ? undefined : c.inline?.dot}
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            muted ? "bg-muted-foreground/50" : !c.inline && c.style.dot,
          )}
        />
      )}
      {hasIcon && (
        // Tag icons follow the chip's text colour (mono) so brand glyphs stay
        // cohesive inside a coloured pill; emoji render in their own colour.
        <AppIcon icon={tag.icon} size={ICON_PX[size]} mono className="shrink-0" />
      )}
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`移除标签 ${tag.name}`}
          className="-mr-0.5 ml-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-current opacity-70 transition-opacity hover:bg-foreground/10 hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
})

// TagList renders a node's tags as a wrapped row with a "+N" overflow chip.
export function TagList({
  tags,
  max = 4,
  size = "sm",
  className,
}: {
  tags?: Pick<AssetTag, "name" | "color" | "icon">[]
  max?: number
  size?: TagBadgeProps["size"]
  className?: string
}) {
  if (!tags || tags.length === 0) return null
  const shown = tags.slice(0, max)
  const extra = tags.length - shown.length
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((t) => (
        <TagBadge key={t.name} tag={t} size={size} showDot />
      ))}
      {extra > 0 && (
        <span className="inline-flex h-6 items-center rounded-full border border-border/70 px-1.5 text-[11px] font-medium text-muted-foreground">
          +{extra}
        </span>
      )}
    </div>
  )
}
