"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"
import type { SearchOptions } from "./terminal-types"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (q: string) => void
  options: SearchOptions
  onOptionsChange: (o: SearchOptions) => void
  resultIndex: number   // 1-based; 0 when no matches
  resultCount: number
  onNext: () => void
  onPrev: () => void
  anchor: React.RefObject<HTMLButtonElement | null>
}

export function TerminalSearchPopover({
  open,
  onOpenChange,
  query,
  onQueryChange,
  options,
  onOptionsChange,
  resultIndex,
  resultCount,
  onNext,
  onPrev,
  anchor,
}: Props) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchor as React.RefObject<HTMLElement>} />
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-[320px] p-2"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const target = e.currentTarget as HTMLElement | null
          const input = target?.querySelector?.("input[data-terminal-search]") as HTMLInputElement | null
          input?.focus()
        }}
      >
        <div className="flex items-center gap-1">
          <Input
            data-terminal-search
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                if (e.shiftKey) onPrev()
                else onNext()
              }
              if (e.key === "Escape") {
                e.preventDefault()
                onOpenChange(false)
              }
            }}
            placeholder="搜索内容…"
            className="h-7 text-xs"
          />
          <button
            onClick={() => onOpenChange(false)}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="mt-2 flex items-center justify-between gap-1">
          <div className="flex items-center gap-0.5">
            <SmallToggle
              pressed={options.caseSensitive}
              onPressedChange={(v) => onOptionsChange({ ...options, caseSensitive: v })}
              icon={CaseSensitive}
              label="区分大小写"
            />
            <SmallToggle
              pressed={options.wholeWord}
              onPressedChange={(v) => onOptionsChange({ ...options, wholeWord: v })}
              icon={WholeWord}
              label="全字匹配"
            />
            <SmallToggle
              pressed={options.regex}
              onPressedChange={(v) => onOptionsChange({ ...options, regex: v })}
              icon={Regex}
              label="正则表达式"
            />
          </div>

          <div className="flex items-center gap-1">
            <span
              className={cn(
                "text-[10px] font-mono px-1.5 py-0.5 rounded-md",
                query
                  ? resultCount > 0
                    ? "bg-muted text-foreground"
                    : "bg-destructive/10 text-destructive"
                  : "text-muted-foreground",
              )}
              aria-live="polite"
            >
              {query
                ? resultCount > 0
                  ? `${resultIndex} / ${resultCount}`
                  : "无匹配"
                : "—"}
            </span>
            <ArrowBtn icon={ArrowUp} onClick={onPrev} title="上一个 (Shift+Enter)" disabled={!query} />
            <ArrowBtn icon={ArrowDown} onClick={onNext} title="下一个 (Enter)" disabled={!query} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SmallToggle({
  pressed,
  onPressedChange,
  icon: Icon,
  label,
}: {
  pressed: boolean
  onPressedChange: (v: boolean) => void
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <Toggle
      pressed={pressed}
      onPressedChange={onPressedChange}
      aria-label={label}
      title={label}
      size="sm"
      className="h-6 w-6 p-0 data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
    >
      <Icon className="w-3.5 h-3.5" />
    </Toggle>
  )
}

function ArrowBtn({
  icon: Icon,
  onClick,
  title,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={title}
      className={cn(
        "inline-flex items-center justify-center h-6 w-6 rounded-md transition-colors",
        "text-muted-foreground hover:text-foreground hover:bg-muted/60",
        "disabled:opacity-40 disabled:pointer-events-none",
      )}
    >
      <Icon className="w-3 h-3" />
    </button>
  )
}
