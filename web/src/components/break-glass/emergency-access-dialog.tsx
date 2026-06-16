"use client"

import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { AlertTriangle, ArrowRight, Clock, LifeBuoy, Search, ShieldCheck, Sparkles } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { AppIcon } from "@/components/icons/app-icon"
import { toast } from "@/components/ui/sonner"
import { breakGlassService, meService, nodeService } from "@/lib/api/services"
import { nodeIcon } from "@/lib/icons/protocol"
import {
  BG_CONSEQUENCES,
  BG_DURATION_PRESETS,
  BG_REASON_TEMPLATES,
  bgFormatRemaining,
} from "@/lib/break-glass/meta"
import { CountdownRing } from "@/components/break-glass/countdown-ring"
import type { BreakGlassActivation, BreakGlassMode, Node } from "@/lib/api/types"
import { cn } from "@/lib/utils"

export interface EmergencyAccessDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  presetNodeId?: number
  onActivated?: (activation: BreakGlassActivation) => void
}

const DEFAULT_DURATION = 30 * 60

export function EmergencyAccessDialog({
  open,
  onOpenChange,
  presetNodeId,
  onActivated,
}: EmergencyAccessDialogProps) {
  const [nodeId, setNodeId] = React.useState<number | undefined>(presetNodeId)
  const [picking, setPicking] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [justification, setJustification] = React.useState("")
  const [activeReason, setActiveReason] = React.useState<string | null>(null)
  const [incidentRef, setIncidentRef] = React.useState("")
  const [durationSec, setDurationSec] = React.useState(DEFAULT_DURATION)
  const [mode, setMode] = React.useState<BreakGlassMode>("pre_approved")
  const [result, setResult] = React.useState<BreakGlassActivation | null>(null)

  React.useEffect(() => {
    if (open) {
      setNodeId(presetNodeId)
      setPicking(presetNodeId == null)
      setSearch("")
      setJustification("")
      setActiveReason(null)
      setIncidentRef("")
      setDurationSec(DEFAULT_DURATION)
      setMode("pre_approved")
      setResult(null)
    }
  }, [open, presetNodeId])

  const nodesQuery = useQuery({
    queryKey: ["nodes", "for-break-glass"],
    queryFn: nodeService.list,
    enabled: open,
    staleTime: 60_000,
  })
  const recentQuery = useQuery({
    queryKey: ["me", "recent-nodes", "break-glass"],
    queryFn: () => meService.recentNodes(8),
    enabled: open && presetNodeId == null,
    staleTime: 60_000,
  })

  const nodes: Node[] = nodesQuery.data?.nodes ?? []
  const byId = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const selectedNode = nodeId != null ? byId.get(nodeId) : undefined

  const recentNodes = React.useMemo(() => {
    const ids = recentQuery.data?.recent?.map((r) => r.node_id) ?? []
    return ids.map((id) => byId.get(id)).filter((n): n is Node => !!n).slice(0, 6)
  }, [recentQuery.data, byId])

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    const base = q
      ? nodes.filter(
          (n) => n.name.toLowerCase().includes(q) || n.host.toLowerCase().includes(q) || String(n.id) === q,
        )
      : nodes
    return base.slice(0, 50)
  }, [nodes, search])

  const pickReason = (text: string, label: string) => {
    setJustification(text)
    setActiveReason(label)
  }

  const activate = useMutation({
    mutationFn: () =>
      breakGlassService.activate({
        node_id: nodeId!,
        justification: justification.trim(),
        incident_ref: incidentRef.trim() || undefined,
        mode,
        duration_sec: durationSec,
      }),
    onSuccess: (res) => {
      setResult(res.activation)
      onActivated?.(res.activation)
      if (res.activation.status === "active") {
        toast.success("应急访问已开通", { description: "请前往工作区连接目标资产" })
      } else {
        toast.success("应急访问申请已提交", { description: "正在等待审批人加速批准" })
      }
    },
    onError: (e: unknown) => toast.error("发起失败", { description: (e as Error).message }),
  })

  const canSubmit = !!nodeId && justification.trim().length > 0 && !activate.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] gap-0 overflow-hidden p-0 sm:max-w-xl">
        {/* warm hero header */}
        <DialogHeader className="space-y-1 border-b bg-gradient-to-b from-orange-500/10 to-transparent px-6 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/15 text-orange-600">
              <LifeBuoy className="h-5 w-5" />
            </span>
            发起应急访问
          </DialogTitle>
          <DialogDescription className="text-sm">
            用于常规授权不可用的紧急情况。每次激活都会被完整记录并通知安全团队，请如实填写，事后需复核。
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <ResultPanel activation={result} />
        ) : (
          <div className="max-h-[58vh] space-y-5 overflow-y-auto px-6 py-5">
            {/* 1 — target asset */}
            <section className="space-y-2">
              <SectionLabel step={1} title="目标资产" />
              {selectedNode && !picking ? (
                <button
                  type="button"
                  disabled={presetNodeId != null}
                  onClick={() => setPicking(true)}
                  className="group flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-orange-300 disabled:cursor-default disabled:hover:border-border"
                >
                  <AppIcon icon={nodeIcon(selectedNode)} className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{selectedNode.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {selectedNode.protocol} · {selectedNode.host}
                    </span>
                  </span>
                  {presetNodeId == null && (
                    <span className="text-xs text-muted-foreground group-hover:text-orange-600">更换</span>
                  )}
                </button>
              ) : (
                <div className="space-y-2">
                  {recentNodes.length > 0 && !search && (
                    <div className="flex flex-wrap gap-1.5">
                      <span className="inline-flex items-center gap-1 py-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" /> 最近
                      </span>
                      {recentNodes.map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            setNodeId(n.id)
                            setPicking(false)
                          }}
                          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:border-orange-300 hover:bg-orange-500/5"
                        >
                          <AppIcon icon={nodeIcon(n)} className="h-3.5 w-3.5" />
                          {n.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="rounded-lg border">
                    <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
                      <Search className="h-3.5 w-3.5 text-muted-foreground" />
                      <input
                        autoFocus
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="按名称 / 主机 / ID 搜索资产…"
                        className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                      />
                    </div>
                    <div className="max-h-40 overflow-y-auto p-1">
                      {nodesQuery.isLoading ? (
                        <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                          <Spinner className="mr-2 h-4 w-4" /> 加载资产…
                        </div>
                      ) : filtered.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的资产</p>
                      ) : (
                        filtered.map((n) => (
                          <button
                            key={n.id}
                            type="button"
                            onClick={() => {
                              setNodeId(n.id)
                              setPicking(false)
                            }}
                            className="flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                          >
                            <AppIcon icon={nodeIcon(n)} className="h-4 w-4 shrink-0" />
                            <span className="truncate font-medium">{n.name}</span>
                            <span className="truncate text-xs text-muted-foreground">{n.host}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* 2 — reason: quick chips + free text */}
            <section className="space-y-2">
              <SectionLabel step={2} title="申请理由" hint="点选常见原因，可再补充" />
              <div className="flex flex-wrap gap-1.5">
                {BG_REASON_TEMPLATES.map((r) => (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => pickReason(r.text, r.label)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      activeReason === r.label
                        ? "border-orange-400 bg-orange-500/10 text-orange-700 dark:text-orange-300"
                        : "hover:border-orange-300 hover:bg-orange-500/5",
                    )}
                  >
                    {activeReason === r.label && <Sparkles className="h-3 w-3" />}
                    {r.label}
                  </button>
                ))}
              </div>
              <Textarea
                value={justification}
                onChange={(e) => {
                  setJustification(e.target.value)
                  setActiveReason(null)
                }}
                placeholder="说明本次应急访问的原因、影响范围与紧急程度…"
                rows={2}
              />
            </section>

            {/* 3 — duration presets + incident ref */}
            <section className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <SectionLabel step={3} title="时长" />
                <div className="flex flex-wrap gap-1.5">
                  {BG_DURATION_PRESETS.map((d) => (
                    <button
                      key={d.sec}
                      type="button"
                      onClick={() => setDurationSec(d.sec)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-xs transition-colors",
                        durationSec === d.sec
                          ? "border-orange-400 bg-orange-500/10 text-orange-700 dark:text-orange-300"
                          : "hover:border-orange-300",
                      )}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">实际时长不超过策略上限</p>
              </div>
              <div className="space-y-2">
                <SectionLabel title="工单 / 事件号" hint="部分策略必填" />
                <Input
                  value={incidentRef}
                  onChange={(e) => setIncidentRef(e.target.value)}
                  placeholder="INC-1234"
                />
              </div>
            </section>

            {/* 4 — mode */}
            <section className="space-y-2">
              <SectionLabel step={4} title="开通方式" />
              <div className="grid gap-2 sm:grid-cols-2">
                <ModeCard
                  active={mode === "pre_approved"}
                  onClick={() => setMode("pre_approved")}
                  icon={<ShieldCheck className="h-4 w-4" />}
                  title="审批激活"
                  hint="任一审批人加速批准后开通"
                  tone="emerald"
                  badge="推荐"
                />
                <ModeCard
                  active={mode === "fail_open"}
                  onClick={() => setMode("fail_open")}
                  icon={<AlertTriangle className="h-4 w-4" />}
                  title="自助破玻璃"
                  hint="立即开通，事后强制复核"
                  tone="orange"
                />
              </div>
            </section>

            {/* consequences strip — 人性化透明 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-muted/50 px-3 py-2.5">
              {BG_CONSEQUENCES.map((c) => (
                <span key={c.label} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <c.icon className="h-3.5 w-3.5" />
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="border-t px-6 py-4">
          {result ? (
            <Button onClick={() => onOpenChange(false)}>完成</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                onClick={() => activate.mutate()}
                disabled={!canSubmit}
                className={mode === "fail_open" ? "bg-orange-600 text-white hover:bg-orange-700" : undefined}
              >
                {activate.isPending && <Spinner className="mr-2 h-4 w-4" />}
                {mode === "fail_open" ? "立即破玻璃" : "提交申请"}
                {!activate.isPending && <ArrowRight className="ml-1.5 h-4 w-4" />}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SectionLabel({ step, title, hint }: { step?: number; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2">
      {step != null && (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
          {step}
        </span>
      )}
      <Label className="text-sm">{title}</Label>
      {hint && <span className="text-xs text-muted-foreground">· {hint}</span>}
    </div>
  )
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  hint,
  tone,
  badge,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  hint: string
  tone: "emerald" | "orange"
  badge?: string
}) {
  const toneCls =
    tone === "emerald"
      ? "border-emerald-400 bg-emerald-500/10 text-emerald-600"
      : "border-orange-400 bg-orange-500/10 text-orange-600"
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
        active ? toneCls : "hover:bg-accent",
      )}
    >
      <span className={cn("mt-0.5", active ? "" : "text-muted-foreground")}>{icon}</span>
      <span className="min-w-0 space-y-0.5">
        <span className="flex items-center gap-1.5">
          <span className={cn("text-sm font-medium", active ? "text-foreground" : "")}>{title}</span>
          {badge && (
            <span className="rounded bg-emerald-500/15 px-1 py-px text-[10px] text-emerald-700 dark:text-emerald-300">
              {badge}
            </span>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  )
}

function ResultPanel({ activation }: { activation: BreakGlassActivation }) {
  const active = activation.status === "active"
  return (
    <div className="px-6 py-8">
      <div className="flex flex-col items-center text-center">
        {active ? (
          <CountdownRing notBefore={activation.activated_at} notAfter={activation.not_after} size={92} />
        ) : (
          <span className="flex h-[92px] w-[92px] items-center justify-center rounded-full bg-amber-500/10">
            <Clock className="h-9 w-9 text-amber-500" />
          </span>
        )}
        <h3 className="mt-4 text-base font-semibold">
          {active ? "应急访问已开通" : "应急访问申请已提交"}
        </h3>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          {active ? (
            <>
              目标资产 <b className="text-foreground">{activation.resource_name}</b> 已可访问，剩余{" "}
              <b className="text-orange-600">{bgFormatRemaining(activation.not_after)}</b>。前往工作区连接，全程录制。
            </>
          ) : (
            <>
              已为 <b className="text-foreground">{activation.resource_name}</b> 提交申请，正在等待审批人加速批准；
              批准后自动开通，可在「我的应急访问」查看进度。
            </>
          )}
        </p>
      </div>
    </div>
  )
}
