"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Plus, Tag as TagIcon } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { tagService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { defaultTagColor, type TagColorToken } from "@/lib/tags/palette"
import type { AssetTag, AssetTagGroup } from "@/lib/api/types"
import { TagBadge } from "./tag-badge"
import { ColorSwatchPicker } from "./color-emoji"
import { IconPicker } from "@/components/icons/icon-picker"

// TagPicker — a colourful multi-select for managed tags. Selected tags render
// as removable chips in the trigger; the popover lets you search, toggle, and
// create-as-you-type (with a live colour/emoji preview). Controlled via
// `value` (tag ids) + `onChange`.
export function TagPicker({
  value,
  onChange,
  placeholder = "选择或创建标签…",
  className,
  disabled,
}: {
  value: number[]
  onChange: (ids: number[]) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [newColor, setNewColor] = React.useState<TagColorToken>("coral")
  const [colorTouched, setColorTouched] = React.useState(false)
  const [newEmoji, setNewEmoji] = React.useState("")

  const list = useQuery({ queryKey: ["tags"], queryFn: tagService.list })
  const tags = React.useMemo(() => list.data?.tags ?? [], [list.data])
  const groups = React.useMemo(() => list.data?.groups ?? [], [list.data])
  const byId = React.useMemo(() => {
    const m = new Map<number, AssetTag>()
    for (const t of tags) m.set(t.id, t)
    return m
  }, [tags])

  // Keep the create-preview colour following the typed name until the user
  // explicitly picks a swatch.
  React.useEffect(() => {
    if (!colorTouched) setNewColor(defaultTagColor(query))
  }, [query, colorTouched])

  const selected = value.map((id) => byId.get(id)).filter(Boolean) as AssetTag[]
  const trimmed = query.trim()
  const exact = tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase())
  const canCreate = trimmed.length > 0 && !exact

  const create = useMutation({
    mutationFn: () =>
      tagService.create({
        name: trimmed,
        color: newColor,
        icon: newEmoji || undefined,
      }),
    onSuccess: (tag) => {
      qc.invalidateQueries({ queryKey: ["tags"] })
      onChange([...value, tag.id])
      setQuery("")
      setNewEmoji("")
      setColorTouched(false)
      toast.success(`已创建标签「${tag.name}」`)
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  // Bucket tags by group for grouped rendering.
  const grouped = React.useMemo(() => {
    const byGroup = new Map<number, AssetTag[]>()
    const ungrouped: AssetTag[] = []
    for (const t of tags) {
      if (t.group_id) {
        const arr = byGroup.get(t.group_id) ?? []
        arr.push(t)
        byGroup.set(t.group_id, arr)
      } else {
        ungrouped.push(t)
      }
    }
    return { byGroup, ungrouped }
  }, [tags])

  const previewTag = { name: trimmed || "新标签", color: newColor, icon: newEmoji }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-left text-sm transition-colors hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
        >
          {selected.length > 0 ? (
            selected.map((t) => (
              <TagBadge
                key={t.id}
                tag={t}
                size="sm"
                showDot
                onRemove={() => toggle(t.id)}
              />
            ))
          ) : (
            <span className="flex items-center gap-1.5 px-1 text-muted-foreground">
              <TagIcon className="h-3.5 w-3.5" /> {placeholder}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0">
        <Command shouldFilter>
          <CommandInput
            placeholder="搜索或输入新标签…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {!canCreate && <CommandEmpty>没有匹配的标签</CommandEmpty>}

            {groups.map((g: AssetTagGroup) => {
              const items = grouped.byGroup.get(g.id)
              if (!items || items.length === 0) return null
              return (
                <CommandGroup key={g.id} heading={`${g.icon ? g.icon + " " : ""}${g.name}`}>
                  {items.map((t) => (
                    <TagRow key={t.id} tag={t} selected={value.includes(t.id)} onToggle={() => toggle(t.id)} />
                  ))}
                </CommandGroup>
              )
            })}

            {grouped.ungrouped.length > 0 && (
              <CommandGroup heading={groups.length > 0 ? "未分组" : "标签"}>
                {grouped.ungrouped.map((t) => (
                  <TagRow key={t.id} tag={t} selected={value.includes(t.id)} onToggle={() => toggle(t.id)} />
                ))}
              </CommandGroup>
            )}
          </CommandList>

          {canCreate && (
            <div className="space-y-2 border-t p-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  新建
                </span>
                <TagBadge tag={previewTag} size="sm" showDot />
              </div>
              <div className="flex items-center gap-2">
                <IconPicker value={newEmoji} onChange={setNewEmoji} placeholder="图标" triggerClassName="shrink-0" />
                <ColorSwatchPicker
                  value={newColor}
                  onChange={(t) => {
                    setNewColor(t)
                    setColorTouched(true)
                  }}
                  className="flex-1"
                />
              </div>
              <button
                type="button"
                onClick={() => create.mutate()}
                disabled={create.isPending}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" /> 创建「{trimmed}」
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TagRow({
  tag,
  selected,
  onToggle,
}: {
  tag: AssetTag
  selected: boolean
  onToggle: () => void
}) {
  return (
    <CommandItem value={tag.name} onSelect={onToggle} className="gap-2">
      <span
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {selected && <Check className="h-3 w-3" />}
      </span>
      <TagBadge tag={tag} size="sm" showDot />
      {tag.description && (
        <span className="ml-1 truncate text-xs text-muted-foreground">{tag.description}</span>
      )}
      {typeof tag.count === "number" && tag.count > 0 && (
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {tag.count}
        </span>
      )}
    </CommandItem>
  )
}
