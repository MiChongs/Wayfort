"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { useQuery } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CopyButton } from "@/components/common/copy-button"
import { firewallService } from "@/lib/api/services"
import type { FirewallApplyRequest, FirewallTool, PolicyTemplate } from "@/lib/api/types"
import { downloadText } from "./shared"

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => <div className="inline-flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 加载查看器…</div>,
})

export function ImportExportDialog({
  open,
  onClose,
  nodeId,
  tool,
  onSafeApply,
}: {
  open: boolean
  onClose: () => void
  nodeId: number
  tool: FirewallTool
  onSafeApply: (req: FirewallApplyRequest) => void
}) {
  const { theme } = useTheme()
  const [importText, setImportText] = React.useState("")

  const exportQ = useQuery({
    queryKey: ["fw", nodeId, "export"],
    queryFn: () => firewallService.export(nodeId),
    enabled: open,
  })
  const templatesQ = useQuery({
    queryKey: ["fw", nodeId, "templates"],
    queryFn: () => firewallService.templates(nodeId),
    enabled: open,
    staleTime: 5 * 60_000,
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">规则集 · 模板 · 导入导出</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="templates">
          <TabsList>
            <TabsTrigger value="templates">策略模板</TabsTrigger>
            <TabsTrigger value="export">导出</TabsTrigger>
            <TabsTrigger value="import">导入</TabsTrigger>
          </TabsList>

          <TabsContent value="templates" className="space-y-2">
            {(templatesQ.data?.templates ?? []).map((t) => (
              <TemplateCard key={t.id} tpl={t} onApply={() => { onSafeApply({ kind: "template", template_id: t.id, confirm: true }); onClose() }} />
            ))}
          </TabsContent>

          <TabsContent value="export">
            {exportQ.isLoading ? (
              <div className="p-4 text-xs text-muted-foreground"><Loader2 className="inline h-3 w-3 animate-spin" /> 读取规则集…</div>
            ) : (
              <div className="space-y-2">
                <div className="h-[min(48vh,360px)] overflow-hidden rounded-md border">
                  <MonacoEditor height="100%" language="ini" theme={theme === "dark" ? "vs-dark" : "light"} value={exportQ.data?.content ?? ""} options={{ readOnly: true, fontSize: 12, minimap: { enabled: false }, wordWrap: "on" }} />
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{exportQ.data?.format}</Badge>
                  <CopyButton value={exportQ.data?.content ?? ""} label="复制" size="sm" variant="outline" />
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => downloadText("firewall-rules.txt", exportQ.data?.content ?? "")}><Download className="h-3.5 w-3.5" /> 下载</Button>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="import" className="space-y-2">
            <p className="text-[11px] text-warning">导入会替换整套规则集——将通过安全应用（倒计时自动回滚）保护。</p>
            <Textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="粘贴 iptables-save / nft / ufw 规则集…" className="h-[min(36vh,280px)] font-mono text-[11px]" />
            <div className="flex justify-end">
              <Button size="sm" disabled={!importText.trim()} onClick={() => { onSafeApply({ kind: "import", content: importText, format: tool === "nft" ? "nft" : tool === "iptables" ? "iptables-save" : "", confirm: true }); onClose() }}>
                安全应用导入
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function TemplateCard({ tpl, onApply }: { tpl: PolicyTemplate; onApply: () => void }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">{tpl.name}</span>
            {tpl.high_risk && <Badge className="h-4 border-warning/40 bg-warning/[0.08] px-1.5 text-[9px] text-warning">高危</Badge>}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{tpl.description}</div>
        </div>
        <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs" onClick={onApply}>套用</Button>
      </CardContent>
    </Card>
  )
}
