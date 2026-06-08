"use client"

import * as React from "react"
import { Check, ChevronRight, Minus, Search } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { groupToolsByFamily } from "@/lib/ai/tool-families"
import { isDangerName } from "@/components/ai/tool-icons"
import type { AITool } from "@/lib/api/types"

// A tri-state checkbox glyph (none / some / all) used for both rows and family
// headers. Coral is reserved for the checked state only (DESIGN: scarce coral).
function CheckBox({ state }: { state: "on" | "off" | "partial" }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        state === "on"
          ? "border-primary bg-primary text-primary-foreground"
          : state === "partial"
            ? "border-primary/50 bg-primary/15 text-primary"
            : "border-border bg-background",
      )}
    >
      {state === "on" && <Check className="size-3" strokeWidth={3} />}
      {state === "partial" && <Minus className="size-3" strokeWidth={3} />}
    </span>
  )
}

export function ToolMultiSelect({
  tools,
  selected,
  onChange,
}: {
  tools: AITool[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [query, setQuery] = React.useState("")
  const [selectedOnly, setSelectedOnly] = React.useState(false)
  const [open, setOpen] = React.useState<Record<string, boolean>>({})
  const sel = React.useMemo(() => new Set(selected), [selected])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return tools.filter((t) => {
      if (selectedOnly && !sel.has(t.name)) return false
      if (!q) return true
      return t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q)
    })
  }, [tools, query, selectedOnly, sel])

  const groups = React.useMemo(() => groupToolsByFamily(filtered), [filtered])

  const toggle = (name: string) => {
    onChange(sel.has(name) ? selected.filter((n) => n !== name) : [...selected, name])
  }
  const setMany = (names: string[], on: boolean) => {
    const next = new Set(selected)
    for (const n of names) {
      if (on) next.add(n)
      else next.delete(n)
    }
    onChange([...next])
  }

  const searching = query.trim().length > 0

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索工具（名称 / 描述）…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <button
          type="button"
          onClick={() => setSelectedOnly((v) => !v)}
          className={cn(
            "h-8 shrink-0 rounded-md border px-2.5 text-xs transition-colors",
            selectedOnly ? "border-primary/25 bg-primary/10 text-primary" : "border-border hover:bg-accent",
          )}
        >
          仅看已选
        </button>
        <div className="flex shrink-0 gap-1 text-xs text-muted-foreground">
          <button type="button" className="rounded px-1.5 py-1 hover:text-foreground" onClick={() => onChange(tools.map((t) => t.name))}>
            全选
          </button>
          <button type="button" className="rounded px-1.5 py-1 hover:text-foreground" onClick={() => onChange([])}>
            清空
          </button>
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground">
        已选 <span className="font-medium text-foreground tabular-nums">{selected.length}</span> / {tools.length} 个工具
      </div>

      <div className="max-h-80 divide-y divide-border/50 overflow-y-auto rounded-md border border-border/70">
        {groups.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">无匹配工具</div>
        )}
        {groups.map(({ family, tools: famTools }) => {
          const names = famTools.map((t) => t.name)
          const onCount = names.filter((n) => sel.has(n)).length
          const famState = onCount === 0 ? "off" : onCount === names.length ? "on" : "partial"
          const isOpen = open[family.key] ?? (searching || selectedOnly)
          const Icon = family.icon
          return (
            <Collapsible key={family.key} open={isOpen} onOpenChange={(o) => setOpen((m) => ({ ...m, [family.key]: o }))}>
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setMany(names, famState !== "on")}
                  aria-label={`全选/取消 ${family.label}`}
                  className="shrink-0"
                >
                  <CheckBox state={famState} />
                </button>
                <CollapsibleTrigger asChild>
                  <button type="button" className="group flex min-w-0 flex-1 items-center gap-2 text-left">
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-medium">{family.label}</span>
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                      {onCount}/{names.length}
                    </span>
                  </button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <div className="grid grid-cols-1 gap-1 px-2 pb-2 md:grid-cols-2">
                  {famTools.map((t) => {
                    const on = sel.has(t.name)
                    const danger = isDangerName(t.name) || t.danger === "high"
                    return (
                      <button
                        type="button"
                        key={t.name}
                        onClick={() => toggle(t.name)}
                        title={t.description}
                        className={cn(
                          "flex items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                          on
                            ? "border-primary/25 bg-primary/10"
                            : "border-transparent hover:border-border hover:bg-accent/50",
                        )}
                      >
                        <CheckBox state={on ? "on" : "off"} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1">
                            <code className={cn("font-mono text-[11px]", on && "text-primary")}>{t.name}</code>
                            {danger && (
                              <Badge variant="outline" className="h-3.5 border-destructive/40 px-1 text-[9px] text-destructive">
                                高危
                              </Badge>
                            )}
                            {t.required_perm && (
                              <Badge variant="outline" className="h-3.5 px-1 text-[9px] text-muted-foreground">
                                {t.required_perm}
                              </Badge>
                            )}
                          </span>
                          {t.description && (
                            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{t.description}</span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </div>
    </div>
  )
}
