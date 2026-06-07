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
  tone?: "default" | "success" | "warning" | "danger"
  children?: React.ReactNode
  className?: string
}

// Warm semantic tints per DESIGN.md — sage / amber-gold / brick. Used as
// barely-there 1px borders + ~6% wash, never as big color blocks.
const TONE: Record<NonNullable<StatCardProps["tone"]>, string> = {
  default: "border-border/60",
  success: "border-success/40 bg-success/[0.06]",
  warning: "border-warning/40 bg-warning/[0.06]",
  danger: "border-destructive/40 bg-destructive/[0.06]",
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
        <div className="text-2xl font-medium tabular-nums leading-tight">{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
        {children}
      </CardContent>
    </Card>
  )
}
