"use client"

// Phase 10 — dedicated page for proxy chain templates. Templates are
// reusable hop sequences stamped onto nodes from the AddNodeSheet's chain
// builder. Here operators can review the catalog, lint stale ones, and run
// real probes without leaving the admin surface.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"
import {
  AlertCircle,
  CheckCircle2,
  Layers,
  Loader2,
  Pencil,
  Plus,
  ShieldAlert,
  Sparkles,
  Zap,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { ProxyChainSummary } from "@/components/admin/proxy-chain-builder"
import { ProxyChainCanvas } from "@/components/admin/proxy-chain-canvas"
import { chainTemplateService, proxyService } from "@/lib/api/services"
import type { ProxyChainTemplate } from "@/lib/api/types"

export default function ChainTemplatesPage() {
  const qc = useQueryClient()
  const templates = useQuery({
    queryKey: ["admin", "chain-templates"],
    queryFn: chainTemplateService.list,
  })
  const proxies = useQuery({ queryKey: ["admin", "proxies"], queryFn: proxyService.list })

  const remove = useMutation({
    mutationFn: (id: number) => chainTemplateService.remove(id),
    onSuccess: () => {
      toast.success("模板已删除")
      qc.invalidateQueries({ queryKey: ["admin", "chain-templates"] })
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })

  const rows = templates.data?.templates || []

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Layers className="h-5 w-5" /> 代理链模板
          </h1>
          <p className="text-sm text-muted-foreground">
            把常走的中转路径保存成模板，新建节点时直接套用，不用每次重连。
          </p>
        </div>
        <ChainTemplateSheet
          proxies={proxies.data?.proxies || []}
          onSaved={() => qc.invalidateQueries({ queryKey: ["admin", "chain-templates"] })}
        />
      </div>

      {templates.isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <Sparkles className="h-6 w-6" />
            还没有模板。点右上角「新建模板」，在画布上拖几个代理连成一条链就能保存。
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence initial={false}>
            {rows.map((t) => (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ type: "spring", stiffness: 320, damping: 26 }}
              >
                <ChainTemplateCard
                  t={t}
                  proxies={proxies.data?.proxies || []}
                  onEdited={() => qc.invalidateQueries({ queryKey: ["admin", "chain-templates"] })}
                  onDelete={() => remove.mutate(t.id)}
                  removing={remove.isPending}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}

function ChainTemplateCard({
  t,
  proxies,
  onEdited,
  onDelete,
  removing,
}: {
  t: ProxyChainTemplate
  proxies: import("@/lib/api/types").Proxy[]
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
    <Card className="overflow-hidden">
      <CardHeader className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{t.name}</CardTitle>
          {errors > 0 ? (
            <Badge variant="outline" className="border-destructive/30 bg-destructive/10 font-normal text-destructive">
              <AlertCircle className="mr-1 h-3 w-3" /> {errors} 错误
            </Badge>
          ) : warnings > 0 ? (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-300">
              <ShieldAlert className="mr-1 h-3 w-3" /> {warnings} 警告
            </Badge>
          ) : (
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 font-normal text-emerald-600 dark:text-emerald-300">
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
            {t.tags.split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => (
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

function ChainTemplateSheet({
  proxies,
  existing,
  onSaved,
  trigger,
}: {
  proxies: import("@/lib/api/types").Proxy[]
  existing?: ProxyChainTemplate
  onSaved: () => void
  trigger?: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState(existing?.name || "")
  const [description, setDescription] = React.useState(existing?.description || "")
  const [chain, setChain] = React.useState(existing?.chain || "")
  const [tags, setTags] = React.useState(existing?.tags || "")

  React.useEffect(() => {
    if (open) {
      setName(existing?.name || "")
      setDescription(existing?.description || "")
      setChain(existing?.chain || "")
      setTags(existing?.tags || "")
    }
  }, [open, existing])

  const save = useMutation({
    mutationFn: () =>
      existing
        ? chainTemplateService.update(existing.id, { name, description, chain, tags })
        : chainTemplateService.create({ name, description, chain, tags }),
    onSuccess: () => {
      toast.success(existing ? "模板已更新" : "模板已创建")
      onSaved()
      setOpen(false)
    },
    onError: (e: Error) => toast.error("保存失败", { description: e.message }),
  })

  const canSave = !!name.trim() && !!chain.trim() && !save.isPending

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button>
            <Plus className="h-4 w-4" /> 新建模板
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="flex h-[82vh] max-w-[min(1100px,95vw)] flex-col gap-0 p-0">
        <DialogHeader className="space-y-1 border-b px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" /> {existing ? "编辑代理链模板" : "新建代理链模板"}
          </DialogTitle>
          <DialogDescription>
            在画布上把代理拖成一条链：客户端 → 中转 …… → 目标。保存后可在任意节点一键套用，套用后仍能在节点里微调。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 border-b px-5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)]">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：华东生产跳板" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">标签</Label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="逗号分隔，可留空" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">说明</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="这条链用在什么场景（可选）" />
          </div>
        </div>

        <div className="min-h-0 flex-1 p-3">
          <ProxyChainCanvas value={chain} onChange={setChain} proxies={proxies} />
        </div>

        <DialogFooter className="flex-row items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {existing ? "保存" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
