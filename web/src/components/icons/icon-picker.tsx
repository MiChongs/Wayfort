"use client"

import * as React from "react"
import { Check, ChevronDown, Search, Type, X } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { AppIcon } from "./app-icon"
import { LUCIDE_ICONS } from "@/lib/icons/lucide"
import { SIMPLE_ICONS } from "@/lib/icons/simple"
import { EMOJI_GROUPS } from "@/lib/icons/emoji"
import { iconToken } from "@/lib/icons/types"

type Tab = "all" | "lucide" | "simple" | "emoji" | "text"

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "lucide", label: "线性" },
  { key: "simple", label: "品牌" },
  { key: "emoji", label: "Emoji" },
  { key: "text", label: "文字" },
]

const RECENT_KEY = "icon-picker:recent"
const RECENT_MAX = 18

function loadRecent(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    return raw ? (JSON.parse(raw) as string[]).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}
function saveRecent(tokens: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(tokens.slice(0, RECENT_MAX)))
  } catch {
    /* ignore */
  }
}

interface Item {
  token: string
  label: string
  search: string
}

const LUCIDE_ITEMS: Item[] = LUCIDE_ICONS.map((e) => ({
  token: iconToken("lucide", e.name),
  label: e.name,
  search: `${e.name} ${e.category} ${e.keywords ?? ""}`.toLowerCase(),
}))
const SIMPLE_ITEMS: Item[] = SIMPLE_ICONS.map((e) => ({
  token: iconToken("simple", e.slug),
  label: e.title,
  search: `${e.slug} ${e.title} ${e.category}`.toLowerCase(),
}))
const EMOJI_ITEMS: Item[] = EMOJI_GROUPS.flatMap((g) =>
  g.emojis.map((ch) => ({ token: iconToken("emoji", ch), label: g.name, search: g.name })),
)

// IconPicker — a reusable, multi-library icon chooser. Controlled via `value`
// (a unified token) + `onChange`. Search spans Lucide + brand icons; tabs scope
// the grid; a Text tab builds tinted-initial tiles; recents persist locally.
export function IconPicker({
  value,
  onChange,
  trigger,
  triggerClassName,
  placeholder = "选择图标",
  align = "start",
}: {
  value?: string
  onChange: (token: string) => void
  trigger?: React.ReactNode
  triggerClassName?: string
  placeholder?: string
  align?: "start" | "center" | "end"
}) {
  const [open, setOpen] = React.useState(false)
  const [tab, setTab] = React.useState<Tab>("all")
  const [q, setQ] = React.useState("")
  const [recent, setRecent] = React.useState<string[]>([])
  const [textDraft, setTextDraft] = React.useState("")

  React.useEffect(() => {
    if (open) setRecent(loadRecent())
  }, [open])

  function pick(token: string) {
    onChange(token)
    if (token) {
      const next = [token, ...recent.filter((t) => t !== token)].slice(0, RECENT_MAX)
      setRecent(next)
      saveRecent(next)
    }
    setOpen(false)
    setQ("")
  }

  const query = q.trim().toLowerCase()
  const sections = React.useMemo(() => {
    const out: { title: string; items: Item[] }[] = []
    const wantLucide = tab === "all" || tab === "lucide"
    const wantSimple = tab === "all" || tab === "simple"
    const wantEmoji = tab === "all" || tab === "emoji"

    if (query) {
      // Text-searchable libraries only (emoji has no labels).
      if (wantLucide) {
        const items = LUCIDE_ITEMS.filter((i) => i.search.includes(query))
        if (items.length) out.push({ title: "线性图标", items })
      }
      if (wantSimple) {
        const items = SIMPLE_ITEMS.filter((i) => i.search.includes(query))
        if (items.length) out.push({ title: "品牌图标", items })
      }
      return out
    }

    if (!query && (tab === "all") && recent.length) {
      out.push({ title: "最近使用", items: recent.map((t) => ({ token: t, label: t, search: "" })) })
    }
    if (wantLucide) out.push({ title: "线性图标", items: LUCIDE_ITEMS })
    if (wantSimple) out.push({ title: "品牌图标", items: SIMPLE_ITEMS })
    if (wantEmoji) out.push({ title: "Emoji", items: EMOJI_ITEMS })
    return out
  }, [tab, query, recent])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm transition-colors hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              triggerClassName,
            )}
          >
            {value ? (
              <AppIcon icon={value} size={18} />
            ) : (
              <Type className="h-4 w-4 text-muted-foreground" />
            )}
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value ? "更换图标" : placeholder}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-0">
        {/* Search + clear */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索图标 / 品牌…"
            className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {value && (
            <button
              type="button"
              onClick={() => pick("")}
              title="清除图标"
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                tab === t.key
                  ? "bg-primary/12 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        {tab === "text" ? (
          <TextTile value={value} onUse={pick} draft={textDraft} setDraft={setTextDraft} />
        ) : (
          <div className="max-h-72 overflow-y-auto px-2 py-2">
            {sections.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">没有匹配的图标</div>
            )}
            {sections.map((sec) => (
              <div key={sec.title} className="mb-2 last:mb-0">
                <div className="px-1 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {sec.title}
                </div>
                <div className="grid grid-cols-8 gap-0.5">
                  {sec.items.map((it, idx) => {
                    const selected = value === it.token
                    return (
                      <button
                        key={`${it.token}-${idx}`}
                        type="button"
                        onClick={() => pick(it.token)}
                        title={it.label}
                        className={cn(
                          "relative grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-accent",
                          selected && "bg-primary/12 ring-1 ring-primary/40",
                        )}
                      >
                        <AppIcon icon={it.token} size={18} />
                        {selected && (
                          <span className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center rounded-full bg-primary text-primary-foreground">
                            <Check className="h-2 w-2" />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function TextTile({
  value,
  draft,
  setDraft,
  onUse,
}: {
  value?: string
  draft: string
  setDraft: (v: string) => void
  onUse: (token: string) => void
}) {
  const preview = (draft || value?.replace(/^text:/, "") || "AB").slice(0, 2)
  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-muted-foreground">输入 1–2 个字符，生成彩色字母图标。</p>
      <div className="flex items-center gap-3">
        <AppIcon icon={iconToken("text", preview)} size={40} className="rounded-lg" />
        <Input
          value={draft}
          maxLength={2}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="如 DB / PG / k8"
          className="h-9 flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) onUse(iconToken("text", draft.trim()))
          }}
        />
      </div>
      <button
        type="button"
        disabled={!draft.trim()}
        onClick={() => onUse(iconToken("text", draft.trim()))}
        className="w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        使用「{preview}」
      </button>
    </div>
  )
}
