"use client"

import * as React from "react"
import { Bot } from "lucide-react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { AppIcon } from "@/components/icons/app-icon"
import type { AIAgent } from "@/lib/api/types"

const PALETTE = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
]

function initialOf(name?: string): string | null {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed) return null
  // First non-whitespace char — handles CJK and Latin alike.
  const first = Array.from(trimmed)[0]
  return first.toUpperCase()
}

function paletteFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function AgentAvatar({
  agent,
  size = "md",
  className,
}: {
  agent?: Pick<AIAgent, "name" | "icon"> | null
  size?: "sm" | "md" | "lg"
  className?: string
}) {
  const icon = agent?.icon?.trim()
  const initial = initialOf(agent?.name)
  const colors = agent?.name ? paletteFor(agent.name) : "bg-card text-foreground border"
  const sizeCls = size === "sm" ? "w-6 h-6 text-[10px]" : size === "lg" ? "w-10 h-10 text-sm" : "w-7 h-7 text-xs"
  const iconSize = size === "sm" ? 14 : size === "lg" ? 20 : 16
  return (
    <Avatar className={cn(sizeCls, "shrink-0 shadow-sm", className)}>
      <AvatarFallback
        className={cn(
          "rounded-full border font-semibold",
          // A chosen icon sits on a neutral surface so brand colours read true;
          // otherwise fall back to the deterministic initials tint.
          icon ? "bg-card" : initial ? colors : "bg-card",
        )}
      >
        {icon ? (
          <AppIcon icon={icon} size={iconSize} />
        ) : (
          initial ?? <Bot className={cn(size === "sm" ? "w-3 h-3" : size === "lg" ? "w-5 h-5" : "w-3.5 h-3.5")} />
        )}
      </AvatarFallback>
    </Avatar>
  )
}
