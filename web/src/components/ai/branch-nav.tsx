"use client"

import { ChevronLeft, ChevronRight, GitBranch } from "lucide-react"

// A compact "‹ 2/3 ›" switcher shown on a user message that has sibling branches
// (created by edit-and-resend). Cycling sets the conversation's active leaf to
// the chosen branch's tip.
export function BranchNav({
  index,
  total,
  onPrev,
  onNext,
  disabled,
}: {
  index: number // 0-based
  total: number
  onPrev: () => void
  onNext: () => void
  disabled?: boolean
}) {
  if (total <= 1) return null
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-border/70 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <GitBranch className="mr-0.5 h-3 w-3" aria-hidden />
      <NavBtn label="上一个分支" onClick={onPrev} disabled={disabled}>
        <ChevronLeft className="h-3 w-3" />
      </NavBtn>
      <span className="px-0.5 tabular-nums">
        {index + 1}/{total}
      </span>
      <NavBtn label="下一个分支" onClick={onNext} disabled={disabled}>
        <ChevronRight className="h-3 w-3" />
      </NavBtn>
    </div>
  )
}

function NavBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {children}
    </button>
  )
}
