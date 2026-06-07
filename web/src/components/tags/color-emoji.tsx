"use client"

import * as React from "react"
import { Check, SmilePlus, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  TAG_COLOR_TOKENS,
  TAG_COLOR_LABELS,
  tagColorStyle,
  type TagColorToken,
} from "@/lib/tags/palette"

// A row of solid colour swatches. Selecting one writes its token back. Shared by
// the tag-picker's inline create form and the admin tag editor.
export function ColorSwatchPicker({
  value,
  onChange,
  className,
}: {
  value?: string
  onChange: (token: TagColorToken) => void
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {TAG_COLOR_TOKENS.map((token) => {
        const active = value === token
        return (
          <button
            key={token}
            type="button"
            onClick={() => onChange(token)}
            title={TAG_COLOR_LABELS[token]}
            aria-label={TAG_COLOR_LABELS[token]}
            aria-pressed={active}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              tagColorStyle(token).solid,
              active && "ring-2 ring-foreground/70 scale-110",
            )}
          >
            {active && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
          </button>
        )
      })}
    </div>
  )
}

// A compact, dependency-free emoji picker — a curated grid of ops/infra glyphs
// plus a "clear" affordance. Opens in a popover. Human-centred, not exhaustive.
const EMOJI_SET = [
  "🏷️", "⭐", "🔥", "⚡", "🚀", "🛡️", "🔒", "🔑",
  "🧪", "🐳", "☁️", "🗄️", "🖥️", "💾", "📦", "🌐",
  "🟢", "🟡", "🔴", "🔵", "🟣", "⚙️", "🧱", "📍",
  "🏠", "🏢", "🧰", "🔧", "✅", "❗", "💡", "🌟",
]

export function EmojiPicker({
  value,
  onChange,
  className,
}: {
  value?: string
  onChange: (emoji: string) => void
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-background text-lg transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            className,
          )}
          aria-label="选择 emoji"
        >
          {value?.trim() ? (
            <span className="leading-none">{value}</span>
          ) : (
            <SmilePlus className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI_SET.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                onChange(e)
                setOpen(false)
              }}
              className={cn(
                "grid h-8 w-8 place-items-center rounded text-lg transition-colors hover:bg-accent",
                value === e && "bg-accent ring-1 ring-primary/40",
              )}
            >
              {e}
            </button>
          ))}
        </div>
        {value?.trim() && (
          <button
            type="button"
            onClick={() => {
              onChange("")
              setOpen(false)
            }}
            className="mt-1.5 flex w-full items-center justify-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" /> 清除
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
