"use client"

import * as React from "react"
import { Plus, Search, Sparkles } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Segmented } from "@/components/common/segmented"
import { VirtualGrid } from "@/components/common/virtual-grid"
import { AppIcon } from "@/components/icons/app-icon"
import { cn } from "@/lib/utils"
import type { AIProviderPreset } from "@/lib/api/types"

const CUSTOM = "__custom__" as const
type GalleryItem = AIProviderPreset | { slug: typeof CUSTOM }

const CATS = [
  { v: "all", label: "全部" },
  { v: "international", label: "国际" },
  { v: "domestic", label: "国内" },
  { v: "local", label: "本地" },
]

const KIND_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openai_compatible: "OpenAI 兼容",
  gemini: "Gemini",
}

// ProviderCatalogGallery is the brand-first "add provider" surface: pick a preset
// to auto-fill the wire protocol, base URL, curated models, and pricing — the
// operator usually only pastes an API key. A dashed tile starts a fully custom
// provider. Virtualized so the full catalog stays smooth.
export function ProviderCatalogGallery({
  presets,
  onSelect,
  onCustom,
}: {
  presets: AIProviderPreset[]
  onSelect: (p: AIProviderPreset) => void
  onCustom: () => void
}) {
  const [cat, setCat] = React.useState("all")
  const [q, setQ] = React.useState("")

  const items = React.useMemo<GalleryItem[]>(() => {
    const needle = q.trim().toLowerCase()
    const filtered = presets.filter((p) => {
      if (cat !== "all" && p.category !== cat) return false
      if (!needle) return true
      return (
        p.name.toLowerCase().includes(needle) ||
        p.slug.toLowerCase().includes(needle) ||
        p.kind.toLowerCase().includes(needle)
      )
    })
    return [{ slug: CUSTOM }, ...filtered]
  }, [presets, cat, q])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={cat} onChange={setCat} options={CATS} />
        <div className="relative ml-auto min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索提供商…"
            className="h-9 pl-8"
          />
        </div>
      </div>

      <VirtualGrid<GalleryItem>
        rows={items}
        height="min(52vh, 460px)"
        columnsClassName="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
        itemKey={(it) => it.slug}
        empty="没有匹配的提供商"
        renderItem={(it) =>
          it.slug === CUSTOM ? (
            <button
              type="button"
              onClick={onCustom}
              className="flex h-full w-full flex-col items-start gap-2 rounded-lg border border-dashed border-border bg-card/40 p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent"
            >
              <span className="inline-flex size-7 items-center justify-center rounded-md border border-dashed text-muted-foreground">
                <Plus className="size-4" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">自定义提供商</div>
                <div className="truncate text-[11px] text-muted-foreground">手填 OpenAI 兼容网关</div>
              </div>
            </button>
          ) : (
            <PresetCard preset={it as AIProviderPreset} onSelect={onSelect} />
          )
        }
      />
    </div>
  )
}

function PresetCard({ preset, onSelect }: { preset: AIProviderPreset; onSelect: (p: AIProviderPreset) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(preset)}
      className="group flex h-full w-full flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
    >
      <div className="flex min-w-0 items-center gap-2">
        <AppIcon icon={preset.icon} size={26} fallback="lucide:sparkles" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{preset.name}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {KIND_LABEL[preset.kind] ?? preset.kind}
        </Badge>
        <span className="truncate text-[11px] text-muted-foreground">
          {preset.models?.length ? `${preset.models.length} 个模型` : "无预置模型"}
        </span>
      </div>
      <span className="mt-auto inline-flex items-center gap-1 text-[11px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
        <Sparkles className="size-3" /> 选择 →
      </span>
    </button>
  )
}

export const CUSTOM_PRESET = CUSTOM
