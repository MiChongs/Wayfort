"use client"

// Extracted from the old /admin/chain-templates page. Warm-token migration:
// the old amber/emerald status badges now use warning/success.

import * as React from "react"
import { AlertCircle, CheckCircle2, Loader2, Pencil, ShieldAlert, Zap } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { ProxyChainSummary } from "@/components/admin/proxy-chain-builder"
import { ChainTemplateSheet } from "@/components/admin/chain-template-sheet"
import { proxyService } from "@/lib/api/services"
import type { Proxy, ProxyChainTemplate } from "@/lib/api/types"

export function ChainTemplateCard({
  t,
  proxies,
  onEdited,
  onDelete,
  removing,
}: {
  t: ProxyChainTemplate
  proxies: Proxy[]
  onEdited: () => void
  onDelete: () => void
  removing: boolean
}) {
  const errors = (t.issues || []).filter((i) => i.severity === "error").length
  const warnings = (t.issues || []).filter((i) => i.severity === "warning").length
  const [testing, setTesting] = React.useState(false)

  const runTest = async () => {
    setTesting(true)
    try {
      const r = await proxyService.testChain(t.chain)
      if (r.ok) toast.success(`模板「${t.name}」链路连通`)
      else toast.error(`模板「${t.name}」链路不通`, { description: r.results?.find((x) => !x.ok)?.error })
    } catch (e) {
      toast.error("测试请求失败", { description: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card className="h-full overflow-hidden">
      <CardHeader className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{t.name}</CardTitle>
          {errors > 0 ? (
            <Badge variant="outline" className="border-destructive/30 bg-destructive/10 font-normal text-destructive">
              <AlertCircle className="mr-1 h-3 w-3" /> {errors} 错误
            </Badge>
          ) : warnings > 0 ? (
            <Badge variant="outline" className="border-warning/30 bg-warning/10 font-normal text-warning">
              <ShieldAlert className="mr-1 h-3 w-3" /> {warnings} 警告
            </Badge>
          ) : (
            <Badge variant="outline" className="border-success/30 bg-success/10 font-normal text-success">
              <CheckCircle2 className="mr-1 h-3 w-3" /> 正常
            </Badge>
          )}
        </div>
        {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
      </CardHeader>
      <CardContent className="space-y-2">
        <ProxyChainSummary chain={t.chain} proxies={proxies} />
        {t.tags && (
          <div className="flex flex-wrap gap-1">
            {t.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)
              .map((tag) => (
                <Badge key={tag} variant="secondary" className="font-normal">
                  {tag}
                </Badge>
              ))}
          </div>
        )}
        <div className="mt-2 flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            测试
          </Button>
          <ChainTemplateSheet
            proxies={proxies}
            existing={t}
            onSaved={onEdited}
            trigger={
              <Button size="sm" variant="ghost">
                <Pencil className="h-3.5 w-3.5" /> 编辑
              </Button>
            }
          />
          <ConfirmDeleteIconButton
            title={`删除模板「${t.name}」？`}
            description="删除模板不影响已经套用它的节点；模板只是一份可复用的链路草稿。"
            loading={removing}
            onConfirm={onDelete}
          />
        </div>
      </CardContent>
    </Card>
  )
}
