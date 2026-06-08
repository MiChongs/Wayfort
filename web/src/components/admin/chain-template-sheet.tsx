"use client"

// Extracted from the old /admin/chain-templates page so both the proxy-center
// templates tab and any deep-link redirect can reuse it. Edits a reusable chain
// preset on a node-graph canvas; the canvas is wrapped in a health provider so
// hop nodes reflect live reachability.

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Loader2, Plus, Sparkles } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
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
import { ProxyChainCanvas } from "@/components/admin/proxy-chain-canvas"
import { ProxyHealthProvider } from "@/components/admin/proxy-health/health-context"
import { chainTemplateService } from "@/lib/api/services"
import type { Proxy, ProxyChainTemplate } from "@/lib/api/types"

export function ChainTemplateSheet({
  proxies,
  existing,
  onSaved,
  trigger,
}: {
  proxies: Proxy[]
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
          <ProxyHealthProvider enabled={open}>
            <ProxyChainCanvas value={chain} onChange={setChain} proxies={proxies} />
          </ProxyHealthProvider>
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
