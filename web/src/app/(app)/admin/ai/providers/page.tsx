"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, LayoutGrid, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { aiProviderService } from "@/lib/api/services"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { ProviderCatalogGallery } from "@/components/ai/providers/provider-catalog-gallery"
import { ProviderListTable } from "@/components/ai/providers/provider-list-table"
import { ProviderSetupWizard } from "@/components/ai/providers/provider-setup-wizard"
import { ProviderDetailSheet } from "@/components/ai/providers/provider-detail-sheet"
import type { AIProvider, AIProviderPreset } from "@/lib/api/types"

export default function AIProvidersPage() {
  const qc = useQueryClient()
  const me = useCurrentUser()
  const canBeGlobal = !!me?.adm

  const list = useQuery({ queryKey: ["ai", "providers"], queryFn: aiProviderService.list })
  const presets = useQuery({ queryKey: ["ai", "provider-presets"], queryFn: aiProviderService.presets })

  const providers = list.data?.providers
  const empty = !list.isLoading && (providers?.length ?? 0) === 0

  const [wizard, setWizard] = React.useState<{ open: boolean; preset: AIProviderPreset | null }>({ open: false, preset: null })
  const [detail, setDetail] = React.useState<AIProvider | null>(null)
  const [galleryOpen, setGalleryOpen] = React.useState(false)

  // Show the gallery as the hero on an empty slate; otherwise it's a toggle.
  const showGallery = empty || galleryOpen

  const openWizard = (preset: AIProviderPreset | null) => {
    setGalleryOpen(false)
    setWizard({ open: true, preset })
  }

  // Keep the detail sheet's data fresh after the list refetches.
  React.useEffect(() => {
    if (!detail || !providers) return
    const fresh = providers.find((p) => p.id === detail.id)
    if (fresh && fresh !== detail) setDetail(fresh)
  }, [providers]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Bot className="size-5" /> AI 提供商
        </h1>
        <div className="flex items-center gap-2">
          {!empty && (
            <Button variant="outline" size="sm" onClick={() => setGalleryOpen((v) => !v)}>
              {galleryOpen ? <X className="size-4" /> : <LayoutGrid className="size-4" />}
              {galleryOpen ? "收起预设" : "浏览预设"}
            </Button>
          )}
          <Button size="sm" onClick={() => openWizard(null)}>
            <Plus className="size-4" /> 新增提供商
          </Button>
        </div>
      </div>

      {showGallery && (
        <div className="rounded-xl border bg-card/40 p-4">
          {empty && (
            <p className="mb-3 text-sm text-muted-foreground">
              还没有配置 AI 提供商。从下面的预设一键接入——自动填好接口地址、已知模型与定价，你通常只需粘贴 API Key。
            </p>
          )}
          <ProviderCatalogGallery
            presets={presets.data?.presets ?? []}
            onSelect={(p) => openWizard(p)}
            onCustom={() => openWizard(null)}
          />
        </div>
      )}

      {!empty && (
        <ProviderListTable providers={providers} loading={list.isLoading} onSelect={(p) => setDetail(p)} />
      )}

      <ProviderSetupWizard
        open={wizard.open}
        preset={wizard.preset}
        canBeGlobal={canBeGlobal}
        onClose={() => setWizard((w) => ({ ...w, open: false }))}
        onCreated={(id) => {
          setWizard((w) => ({ ...w, open: false }))
          qc.invalidateQueries({ queryKey: ["ai", "providers"] })
          // Open the new provider's detail once the list refetches.
          void list.refetch().then((r) => {
            const created = r.data?.providers?.find((p) => p.id === id)
            if (created) setDetail(created)
          })
        }}
      />

      {detail && <ProviderDetailSheet provider={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
