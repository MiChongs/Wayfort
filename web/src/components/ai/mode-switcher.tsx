"use client"

import { motion, useReducedMotion } from "motion/react"
import { ShieldCheck, ShieldAlert, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PermissionMode } from "@/lib/api/types"

const OPTIONS: { value: PermissionMode; label: string; hint: string; icon: typeof Zap }[] = [
  { value: "plan", label: "Plan", hint: "仅规划 dry-run", icon: ShieldCheck },
  { value: "normal", label: "Normal", hint: "写操作需确认", icon: ShieldAlert },
  { value: "bypass", label: "Bypass", hint: "直接执行", icon: Zap },
]

export function ModeSwitcher({
  value,
  onChange,
  size = "md",
}: {
  value: PermissionMode
  onChange: (m: PermissionMode) => void
  size?: "sm" | "md"
}) {
  const reduce = useReducedMotion()
  return (
    <div className={cn(
      "inline-flex items-center rounded-lg border bg-muted/60 p-0.5 relative",
      size === "sm" ? "text-xs" : "text-sm",
    )}>
      {OPTIONS.map((opt) => {
        const active = value === opt.value
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.hint}
            className={cn(
              "relative z-10 inline-flex items-center gap-1.5 px-3 rounded-md font-medium transition-colors",
              size === "sm" ? "h-7" : "h-8",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId="mode-switcher-pill"
                className="absolute inset-0 -z-10 bg-background rounded-md shadow-sm border border-border/60"
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 30 }}
              />
            )}
            <Icon className={cn(size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5")} />
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
