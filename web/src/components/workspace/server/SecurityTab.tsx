"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, ShieldCheck, Wand2, XCircle } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useConfirm } from "@/components/admin/use-confirm"
import { securityService } from "@/lib/api/services"
import type { SecCheck, SecStatus } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { RunInTerminalButton, codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }

const RANK: Record<SecStatus, number> = { danger: 0, warn: 1, info: 2, ok: 3, unknown: 4 }
const CAT_ORDER = ["SSH", "账户", "文件权限", "网络与防护", "内核加固"]

function statusMeta(s: SecStatus) {
  switch (s) {
    case "danger": return { icon: XCircle, tone: "text-destructive", label: "危险" }
    case "warn": return { icon: AlertTriangle, tone: "text-warning", label: "注意" }
    case "ok": return { icon: CheckCircle2, tone: "text-success", label: "通过" }
    default: return { icon: Info, tone: "text-muted-foreground", label: "信息" }
  }
}
function scoreTone(score: number): string {
  if (score >= 85) return "text-success"
  if (score >= 60) return "text-warning"
  return "text-destructive"
}

export function SecurityTab({ nodeId, tabId, active }: Props) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const report = useQuery({
    queryKey: ["security", nodeId],
    queryFn: () => securityService.report(nodeId),
    enabled: active,
    refetchInterval: 60_000,
    retry: false,
  })
  const apply = useMutation({
    mutationFn: (check: string) => securityService.apply(nodeId, check),
    onSuccess: () => { toast.success("已应用修复"); void qc.invalidateQueries({ queryKey: ["security", nodeId] }) },
    onError: (e: ApiError) => {
      const code = codeOf(e)
      toast.error("修复失败", { description: code === "permission_denied" ? "需 root / sudo NOPASSWD。" : e?.message })
    },
  })

  if (!active) return null
  if (report.isError) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <ShieldCheck className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">无法运行安全检查</div>
        <div className="text-xs">{(report.error as ApiError)?.message}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => report.refetch()}><RefreshCw className="w-3 h-3" /> 重试</Button>
      </div>
    )
  }
  const d = report.data
  const grouped = React.useMemo(() => {
    const checks = d?.checks ?? []
    const cats = Array.from(new Set(checks.map((c) => c.category)))
    cats.sort((a, b) => (CAT_ORDER.indexOf(a) + 99 * (CAT_ORDER.indexOf(a) < 0 ? 1 : 0)) - (CAT_ORDER.indexOf(b) + 99 * (CAT_ORDER.indexOf(b) < 0 ? 1 : 0)))
    return cats.map((cat) => ({
      cat,
      checks: checks.filter((c) => c.category === cat).sort((a, b) => RANK[a.status] - RANK[b.status]),
    }))
  }, [d])

  const onApply = async (c: SecCheck) => {
    const ok = await confirm({ title: `应用修复：${c.title}？`, description: "将在节点上以当前 SSH 用户执行加固命令（需 root/sudo）。", confirmLabel: "应用" })
    if (ok) apply.mutate(c.id)
  }

  return (
    <div className="flex flex-col h-full">
      {dialog}
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <ShieldCheck className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">安全态势</span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => report.refetch()} title="重新检查"><RefreshCw className={cn("w-3 h-3", report.isFetching && "animate-spin")} /></Button>
      </header>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {!d ? (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4"><Loader2 className="w-3 h-3 animate-spin" /> 扫描中…</div>
        ) : (
          <>
            <Card>
              <CardContent className="px-3 py-3 flex items-center gap-3">
                <div className={cn("text-3xl font-medium tabular-nums", scoreTone(d.score))}>{d.score}</div>
                <div className="text-[11px] text-muted-foreground">
                  <div>安全评分 / 100</div>
                  <div>{d.checks.filter((c) => c.status === "danger").length} 危险 · {d.checks.filter((c) => c.status === "warn").length} 注意 · {d.checks.length} 项检查</div>
                </div>
              </CardContent>
            </Card>

            {grouped.map((g) => (
              <section key={g.cat} className="space-y-1.5">
                <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-0.5">{g.cat}</h3>
                {g.checks.map((c) => (
                  <CheckRow key={c.id} c={c} tabId={tabId} busy={apply.isPending} onApply={() => onApply(c)} />
                ))}
              </section>
            ))}

            <div className="text-[10px] text-muted-foreground">
              ⓘ「一键修复」会在节点上执行预置的加固命令（受 service security:manage 权限保护并审计）；逐项修复（如改某个文件权限）仍走「发送到终端」由你确认。
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CheckRow({ c, tabId, busy, onApply }: { c: SecCheck; tabId: string; busy: boolean; onApply: () => void }) {
  const meta = statusMeta(c.status)
  const Icon = meta.icon
  const hasItems = (c.items?.length ?? 0) > 0
  const needsFix = c.status === "danger" || c.status === "warn"
  return (
    <Card>
      <CardContent className="px-3 py-2">
        <div className="flex items-start gap-2">
          <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", meta.tone)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{c.title}</span>
              <Badge variant="outline" className={cn("text-[9px] px-1 h-4", meta.tone)}>{meta.label}</Badge>
            </div>
            {c.detail && <div className="text-[11px] text-muted-foreground mt-0.5">{c.detail}</div>}
            {hasItems && (
              <Collapsible>
                <CollapsibleTrigger className="text-[10px] text-primary hover:underline mt-1">查看 {c.items!.length} 项</CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 bg-muted/60 rounded-md p-2 text-[10px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">{c.items!.join("\n")}</pre>
                </CollapsibleContent>
              </Collapsible>
            )}
            {needsFix && (c.applicable || c.fix) && (
              <div className="flex items-center gap-1.5 mt-1.5">
                {c.applicable && (
                  <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1" disabled={busy} onClick={onApply}>
                    <Wand2 className="w-3 h-3" /> 一键修复
                  </Button>
                )}
                {c.fix && <RunInTerminalButton tabId={tabId} command={c.fix} label="把修复命令送到终端" size="sm" />}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
