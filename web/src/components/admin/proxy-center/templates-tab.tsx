"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, Sparkles } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Card, CardContent } from "@/components/ui/card"
import { VirtualGrid } from "@/components/common/virtual-grid"
import { ChainTemplateCard } from "@/components/admin/chain-template-card"
import { ChainTemplateSheet } from "@/components/admin/chain-template-sheet"
import { chainTemplateService } from "@/lib/api/services"
import type { Proxy, ProxyChainTemplate } from "@/lib/api/types"

export function TemplatesTab({
  templates,
  proxies,
  loading,
}: {
  templates: ProxyChainTemplate[]
  proxies: Proxy[]
  loading?: boolean
}) {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "chain-templates"] })

  const remove = useMutation({
    mutationFn: (id: number) => chainTemplateService.remove(id),
    onSuccess: () => {
      toast.success("模板已删除")
      invalidate()
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <ChainTemplateSheet proxies={proxies} onSaved={invalidate} />
      </div>

      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </CardContent>
        </Card>
      ) : templates.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <Sparkles className="h-6 w-6" />
            还没有模板。点右上角「新建模板」，在画布上拖几个代理连成一条链就能保存。
          </CardContent>
        </Card>
      ) : (
        <VirtualGrid
          rows={templates}
          itemKey={(t) => t.id}
          renderItem={(t) => (
            <ChainTemplateCard
              t={t}
              proxies={proxies}
              onEdited={invalidate}
              onDelete={() => remove.mutate(t.id)}
              removing={remove.isPending}
            />
          )}
        />
      )}
    </div>
  )
}
