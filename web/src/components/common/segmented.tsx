"use client"

import { cn } from "@/lib/utils"

// Segmented is the small pill toggle used for day-range / scope switches across
// the AI usage + provider surfaces. Extracted so the provider detail panel and
// the catalog gallery share one control.
export function Segmented({
  value,
  onChange,
  options,
  className,
}: {
  value: string
  onChange: (v: string) => void
  options: { v: string; label: string }[]
  className?: string
}) {
  return (
    <div className={cn("inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
