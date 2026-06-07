"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { DURATION_PRESETS } from "@/lib/approvals/meta"

// DurationField — preset chips + a custom-hours entry, shared by the create
// dialog (requester picks a window) and the decision controls (approver tunes
// the issued window). When `allowDefault` is on, a leading "按申请" chip maps to
// value 0, which the API reads as "keep the requester's asked-for window".
export function DurationField({
  value,
  onChange,
  allowDefault = false,
  defaultLabel = "按申请",
  presets = DURATION_PRESETS,
  className,
}: {
  value: number
  onChange: (sec: number) => void
  allowDefault?: boolean
  defaultLabel?: string
  presets?: { label: string; sec: number }[]
  className?: string
}) {
  const isPreset = presets.some((p) => p.sec === value) || (allowDefault && value === 0)
  const [custom, setCustom] = React.useState(isPreset ? "" : String(value / 3600))

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {allowDefault && (
        <Chip active={value === 0} onClick={() => onChange(0)}>
          {defaultLabel}
        </Chip>
      )}
      {presets.map((p) => (
        <Chip key={p.sec} active={value === p.sec} onClick={() => onChange(p.sec)}>
          {p.label}
        </Chip>
      ))}
      <div
        className={cn(
          "flex items-center gap-1 rounded-lg border px-2 py-1 transition-colors",
          !isPreset && value > 0 ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        <Input
          value={custom}
          onChange={(e) => {
            const raw = e.target.value
            setCustom(raw)
            const h = Number(raw)
            if (h > 0) onChange(Math.round(h * 3600))
          }}
          inputMode="decimal"
          placeholder="自定义"
          className="h-6 w-14 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
        />
        <span className="pr-0.5 text-xs text-muted-foreground">小时</span>
      </div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-2.5 py-1 text-sm transition-colors",
        active ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent",
      )}
    >
      {children}
    </button>
  )
}
