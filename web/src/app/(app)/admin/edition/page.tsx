"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BadgeCheck, Crown, ShieldCheck, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/sonner"
import { editionAdminService } from "@/lib/api/services"
import { useAccess } from "@/lib/hooks/use-access"
import { cn } from "@/lib/utils"
import type { AdminEditionInfo, EditionFeature, EditionState, EditionTier } from "@/lib/api/types"

const TIER_LABEL: Record<EditionTier, string> = {
  community: "社区版",
  enterprise: "企业版",
  flagship: "旗舰版",
}

type BadgeVariant = "soft" | "success" | "warning" | "destructive"
const STATE: Record<EditionState, { label: string; variant: BadgeVariant }> = {
  community: { label: "未授权", variant: "soft" },
  active: { label: "授权有效", variant: "success" },
  grace: { label: "宽限期", variant: "warning" },
  expired: { label: "已过期", variant: "destructive" },
  invalid: { label: "授权无效", variant: "destructive" },
}

// Labels client-side so the API never ships a full paid-feature catalog.
const FEATURE_LABEL: Record<EditionFeature, string> = {
  break_glass: "应急访问治理",
  security_analytics: "安全分析",
  reverse_agent: "反连网关 + 内部 PKI",
  ai: "AI 助手",
  desktop: "图形会话",
  advanced_kms: "高级密钥管理",
  connection_review: "资产连接复核",
  data_masking: "数据脱敏",
  connection_method: "连接方式控制",
}

const TIER_ICON: Record<EditionTier, React.ElementType> = {
  community: Sparkles,
  enterprise: ShieldCheck,
  flagship: Crown,
}

function fmtDate(ts?: string): string {
  if (!ts) return "—"
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

export default function EditionAdminPage() {
  const { isSuperadmin, loading: accessLoading } = useAccess()
  const qc = useQueryClient()
  const [license, setLicense] = React.useState("")

  const q = useQuery({ queryKey: ["admin", "edition"], queryFn: editionAdminService.get })

  const apply = (data: AdminEditionInfo) => {
    qc.setQueryData(["admin", "edition"], data)
    qc.invalidateQueries({ queryKey: ["me", "edition"] })
  }

  const install = useMutation({
    mutationFn: () => editionAdminService.install(license.trim()),
    onSuccess: (data) => {
      apply(data)
      setLicense("")
      toast.success(`已激活 ${TIER_LABEL[data.edition]}`, { description: data.customer || undefined })
    },
    onError: (e: unknown) => toast.error("激活失败", { description: e instanceof Error ? e.message : String(e) }),
  })

  const remove = useMutation({
    mutationFn: () => editionAdminService.remove(),
    onSuccess: (data) => {
      apply(data)
      toast.success("已移除授权")
    },
    onError: (e: unknown) => toast.error("移除失败", { description: e instanceof Error ? e.message : String(e) }),
  })

  if (accessLoading) return null
  if (!isSuperadmin) {
    return <div className="p-6 text-sm text-muted-foreground">仅超级管理员可管理授权。</div>
  }

  const info = q.data
  const tier: EditionTier = info?.edition ?? "community"
  const state: EditionState = info?.state ?? "community"
  const stateMeta = STATE[state]
  const TierIcon = TIER_ICON[tier]
  const isPaid = tier !== "community"
  const activeFeatures = (Object.keys(FEATURE_LABEL) as EditionFeature[]).filter((k) => info?.features?.[k])
  const calloutTone =
    state === "grace" ? "warning" : state === "expired" || state === "invalid" ? "destructive" : null

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header>
        <p className="eyebrow">授权</p>
        <h1 className="text-2xl font-semibold">版本与授权</h1>
        <p className="mt-1 text-sm text-muted-foreground">导入授权以解锁对应版本的功能。</p>
      </header>

      {/* Current status */}
      <section className="space-y-4 rounded-xl border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                isPaid ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              <TierIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <div className="text-base font-medium">{TIER_LABEL[tier]}</div>
              <div className="truncate text-sm text-muted-foreground">
                {info?.customer ? `授权给 ${info.customer}` : "当前未导入授权"}
              </div>
            </div>
          </div>
          <Badge variant={stateMeta.variant} className="shrink-0">
            {stateMeta.label}
          </Badge>
        </div>

        {info?.message && calloutTone && (
          <p
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              calloutTone === "warning"
                ? "border-warning/30 bg-warning/10 text-warning"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {info.message}
          </p>
        )}
        {info && !info.supported && (
          <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            当前网关构建不支持导入授权，请联系供应商获取企业版构建。
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <Field label="到期时间" value={info?.licensed ? (info?.expires_at ? fmtDate(info.expires_at) : "永久") : "—"} />
          {info?.grace_until && <Field label="宽限截止" value={fmtDate(info.grace_until)} />}
          {info?.limits?.max_nodes ? <Field label="节点上限" value={String(info.limits.max_nodes)} /> : null}
        </dl>

        {activeFeatures.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t pt-4">
            {activeFeatures.map((k) => (
              <Badge key={k} variant="soft" className="rounded-full font-normal">
                {FEATURE_LABEL[k]}
              </Badge>
            ))}
          </div>
        )}
      </section>

      {/* Install / remove */}
      <section className="space-y-3 rounded-xl border bg-card p-5">
        <div>
          <div className="text-sm font-medium">导入授权</div>
          <p className="text-sm text-muted-foreground">粘贴供应商提供的授权码，导入后立即生效。</p>
        </div>
        <Label htmlFor="license" className="sr-only">
          授权码
        </Label>
        <Textarea
          id="license"
          value={license}
          onChange={(e) => setLicense(e.target.value)}
          placeholder="在此粘贴授权码…"
          className="min-h-28 font-mono text-xs"
          disabled={info && !info.supported}
        />
        <div className="flex items-center gap-2">
          <Button
            onClick={() => install.mutate()}
            disabled={!license.trim() || install.isPending || (info && !info.supported)}
            className="gap-1.5"
          >
            {install.isPending ? <Spinner className="h-4 w-4" /> : <BadgeCheck className="h-4 w-4" />}
            激活授权
          </Button>
          {info?.licensed && (
            <Button
              variant="ghost"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="gap-1.5 text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" /> 移除授权
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate">{value || "—"}</dd>
    </div>
  )
}
