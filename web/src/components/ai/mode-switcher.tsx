"use client"

import { motion, useReducedMotion } from "motion/react"
import { ShieldCheck, ShieldAlert, Zap } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { PermissionMode } from "@/lib/api/types"

const OPTIONS: {
  value: PermissionMode
  label: string
  hint: string
  icon: typeof Zap
}[] = [
  { value: "plan", label: "Plan", hint: "仅规划，所有写操作走 dry-run", icon: ShieldCheck },
  { value: "normal", label: "Normal", hint: "写操作前请求你的确认", icon: ShieldAlert },
  { value: "bypass", label: "Bypass", hint: "直接执行，无需确认（仍受 RBAC 限制）", icon: Zap },
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
  const sm = size === "sm"
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as PermissionMode)}
      className={cn(sm ? "h-8 p-0.5" : "h-9 p-0.5", "shadow-sm")}
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon
        const active = value === opt.value
        return (
          <Tooltip key={opt.value}>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value={opt.value}
                aria-label={opt.label}
                className={cn(
                  "relative px-3 gap-1.5",
                  sm ? "h-7 text-xs" : "h-8 text-sm",
                  active && "text-foreground",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="mode-switcher-pill"
                    className="absolute inset-0 -z-10 bg-background rounded-md shadow-sm border border-border/60"
                    transition={
                      reduce
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 380, damping: 30 }
                    }
                  />
                )}
                <Icon className={sm ? "w-3 h-3" : "w-3.5 h-3.5"} />
                {opt.label}
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[220px]">
              <div className="font-medium mb-0.5">{opt.label}</div>
              <div className="text-muted-foreground">{opt.hint}</div>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </ToggleGroup>
  )
}
