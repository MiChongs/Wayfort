"use client"

import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export interface StatCardProps {
  icon?: LucideIcon
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: "default" | "amber" | "rose" | "sky"
  children?: React.ReactNode
  className?: string
}

const TONE: Record<NonNullable<StatCardProps["tone"]>, string> = {
  default: "border-border/60",
  amber: "border-amber-500/40 bg-amber-500/5",
  rose: "border-rose-500/40 bg-rose-500/5",
  sky: "border-sky-500/40 bg-sky-500/5",
}

/**
 * Compact metric card used on the insights overview tab. Renders an optional
 * icon, a small uppercase label, a large value and either a hint line below
 * or arbitrary children (e.g. a Sparkline).
 */
export function StatCard({ icon: Icon, label, value, hint, tone = "default", children, className }: StatCardProps) {
  return (
    <Card className={cn("py-3", TONE[tone], className)}>
      <CardContent className="px-3 py-0 space-y-1">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wide">
          {Icon && <Icon className="w-3 h-3" />}
          <span>{label}</span>
        </div>
        <div className="text-2xl font-semibold tabular-nums leading-tight">{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
        {children}
      </CardContent>
    </Card>
  )
}
