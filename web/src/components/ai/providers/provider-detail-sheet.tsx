"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Activity, Coins, Cpu, Gauge, Loader2, Plus, RefreshCw, Save, Star, TestTube2, Trash2, X } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { MaybeVirtualList } from "@/lib/ai/maybe-virtual"
import { AppIcon } from "@/components/icons/app-icon"
import { Segmented } from "@/components/common/segmented"
import { fmtCost, fmtPrice, fmtTok } from "@/lib/ai/usage-format"
import { aiProviderService, type ProviderHealthSnapshot } from "@/lib/api/services"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { CapabilityBadges } from "./capability-badges"
import { HealthDot } from "./health-dot"
import { presetIconFor } from "./preset-icons"
import { cn } from "@/lib/utils"
import type { AIModel, AIProvider } from "@/lib/api/types"

export function ProviderDetailSheet({
  provider,
  onClose,
}: {
  provider: AIProvider
  onClose: () => void
}) {
  const healthURL = React.useMemo(() => aiProviderService.healthStreamURL(), [])
  const { data: snap, status } = useSseSnapshot<ProviderHealthSnapshot>(healthURL)
  const health = snap?.providers?.[provider.id] ?? provider.health

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <AppIcon icon={presetIconFor(provider)} size={30} fallback="lucide:sparkles" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold">{provider.display_name || provider.name}</div>
            <div className="mt-0.5 flex items-center gap-2">
              <HealthDot health={health} status={status} />
              {provider.is_global ? <Badge variant="success" className="text-[10px]">全局</Badge> : <Badge variant="outline" className="text-[10px]">个人</Badge>}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="size-4" /></Button>
        </div>

        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-5 mt-3 grid w-auto grid-cols-5">
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="models">模型</TabsTrigger>
            <TabsTrigger value="limits">限流</TabsTrigger>
            <TabsTrigger value="network">网络</TabsTrigger>
            <TabsTrigger value="usage">用量</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <TabsContent value="overview" className="mt-0">
              <OverviewPanel provider={provider} health={health} />
            </TabsContent>
            <TabsContent value="models" className="mt-0">
              <ModelsPanel provider={provider} />
            </TabsContent>
            <TabsContent value="limits" className="mt-0">
              <LimitsPanel provider={provider} health={health} />
            </TabsContent>
            <TabsContent value="network" className="mt-0">
              <NetworkPanel provider={provider} />
            </TabsContent>
            <TabsContent value="usage" className="mt-0">
              <UsagePanel providerId={provider.id} />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function Stat({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <div className="mt-1 text-base font-medium tabular-nums">{value}</div>
    </div>
  )
}

function OverviewPanel({ provider, health }: { provider: AIProvider; health?: AIProvider["health"] }) {
  const test = useMutation({
    mutationFn: () => aiProviderService.test(provider.id),
    onSuccess: (r) => (r.ok ? toast.success("拨测成功", { description: r.latency_ms ? `延迟 ${r.latency_ms}ms` : undefined }) : toast.error("拨测失败", { description: r.error })),
    onError: (e: unknown) => toast.error("拨测失败", { description: (e as Error).message }),
  })
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat icon={Activity} label="延迟" value={typeof health?.latency_ms === "number" ? `${health.latency_ms}ms` : "—"} />
        <Stat icon={Cpu} label="模型数" value={health?.model_count != null ? String(health.model_count) : String(provider.models?.length ?? "—")} />
        <Stat icon={Gauge} label="状态" value={health?.state === "online" ? "在线" : health?.state === "degraded" ? "降级" : health?.state === "offline" ? "离线" : "未知"} />
      </div>
      <dl className="space-y-2 rounded-xl border bg-card p-3 text-sm">
        <Row k="类型" v={provider.kind} />
        <Row k="BaseURL" v={provider.base_url || "官方默认"} mono />
        <Row k="默认模型" v={provider.default_model || "—"} mono />
        <Row k="API Key" v={`…${provider.api_key_last4 || "????"}`} mono />
        {health?.last_error && <Row k="最近错误" v={health.last_error} mono />}
      </dl>
      <Button variant="outline" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
        {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <TestTube2 className="size-4" />} 立即拨测
      </Button>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className={cn("min-w-0 truncate text-right", mono && "font-mono text-xs")} title={v}>{v}</dd>
    </div>
  )
}

function ModelsPanel({ provider }: { provider: AIProvider }) {
  const qc = useQueryClient()
  const [models, setModels] = React.useState<AIModel[]>(() => provider.models ?? [])
  const [def, setDef] = React.useState(provider.default_model ?? "")

  const refresh = useMutation({
    mutationFn: () => aiProviderService.models(provider.id, true),
    onSuccess: (r) => {
      // Union: keep local edits for existing ids, append newly discovered.
      setModels((prev) => {
        const map = new Map(prev.map((m) => [m.id, m]))
        for (const m of r.models ?? []) if (!map.has(m.id)) map.set(m.id, m)
        return [...map.values()]
      })
      toast.success("已从实时发现合并模型")
    },
    onError: (e: unknown) => toast.error("刷新失败", { description: (e as Error).message }),
  })
  const save = useMutation({
    mutationFn: () => aiProviderService.saveModels(provider.id, { models, default_model: def || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "providers"] })
      toast.success("模型已保存")
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  const patchModel = (id: string, p: Partial<AIModel>) =>
    setModels((prev) => prev.map((m) => (m.id === id ? { ...m, ...p } : m)))
  const patchPrice = (id: string, field: "in_per_mtok" | "out_per_mtok", val: number) =>
    setModels((prev) => prev.map((m) => (m.id === id ? { ...m, pricing: { ...m.pricing, [field]: val } } : m)))
  const removeModel = (id: string) => setModels((prev) => prev.filter((m) => m.id !== id))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{models.length} 个模型 · 可编辑能力定价</span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} 从实时刷新
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} 保存
          </Button>
        </div>
      </div>
      {models.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无模型，点「从实时刷新」拉取
        </div>
      ) : (
        <MaybeVirtualList
          items={models}
          threshold={30}
          height="min(56vh, 30rem)"
          className="space-y-1.5"
          itemKey={(m) => m.id}
          renderItem={(m) => (
            <div className="rounded-lg border bg-card p-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  title="设为默认"
                  onClick={() => setDef(m.id)}
                  className={cn("shrink-0 rounded p-0.5", def === m.id ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground")}
                >
                  <Star className={cn("size-3.5", def === m.id && "fill-current")} />
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
                <CapabilityBadges model={m} />
                <button type="button" onClick={() => removeModel(m.id)} className="shrink-0 text-muted-foreground/40 hover:text-destructive">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-6 text-[11px] text-muted-foreground">
                {m.context_window ? <span>{Math.round(m.context_window / 1000)}k ctx</span> : null}
                <span className="inline-flex items-center gap-1">
                  入
                  <PriceInput value={m.pricing?.in_per_mtok} onChange={(v) => patchPrice(m.id, "in_per_mtok", v)} />
                </span>
                <span className="inline-flex items-center gap-1">
                  出
                  <PriceInput value={m.pricing?.out_per_mtok} onChange={(v) => patchPrice(m.id, "out_per_mtok", v)} />
                </span>
                <span className="text-muted-foreground/60">/ 1M tok</span>
                <CapToggle label="工具" on={!!m.tools} onClick={() => patchModel(m.id, { tools: !m.tools })} />
                <CapToggle label="视觉" on={!!m.vision} onClick={() => patchModel(m.id, { vision: !m.vision })} />
                <CapToggle label="思考" on={!!m.reasoning} onClick={() => patchModel(m.id, { reasoning: !m.reasoning })} />
              </div>
            </div>
          )}
        />
      )}
    </div>
  )
}

function PriceInput({ value, onChange }: { value?: number; onChange: (v: number) => void }) {
  return (
    <Input
      type="number"
      step="0.01"
      min="0"
      value={value ?? ""}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
      placeholder={fmtPrice(value).replace("$", "") || "0"}
      className="h-6 w-16 px-1.5 text-[11px] tabular-nums"
    />
  )
}

function CapToggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-[10px] transition-colors",
        on ? "border-primary/25 bg-primary/10 text-primary" : "border-border text-muted-foreground/50",
      )}
    >
      {label}
    </button>
  )
}

function LimitsPanel({ provider, health }: { provider: AIProvider; health?: AIProvider["health"] }) {
  const qc = useQueryClient()
  const [rpm, setRpm] = React.useState(provider.rate_limit_rpm ?? 0)
  const [tpm, setTpm] = React.useState(provider.rate_limit_tpm ?? 0)
  const save = useMutation({
    mutationFn: () => aiProviderService.update(provider.id, { rate_limit_rpm: rpm, rate_limit_tpm: tpm }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "providers"] })
      toast.success("限流已更新")
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">0 表示不限。超限时该提供商的请求会被拒绝并提示稍后重试。</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">每分钟请求数 (RPM)</Label>
          <Input type="number" min="0" value={rpm} onChange={(e) => setRpm(Number(e.target.value) || 0)} className="tabular-nums" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">每分钟 token 数 (TPM)</Label>
          <Input type="number" min="0" value={tpm} onChange={(e) => setTpm(Number(e.target.value) || 0)} className="tabular-nums" />
        </div>
      </div>
      {health && (health.req_limit || health.tok_limit) ? (
        <div className="space-y-3 rounded-xl border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground">实时余量</div>
          {health.req_limit ? (
            <Gauge2 label="请求" remaining={health.req_remaining ?? 0} limit={health.req_limit} />
          ) : null}
          {health.tok_limit ? (
            <Gauge2 label="token" remaining={health.tok_remaining ?? 0} limit={health.tok_limit} />
          ) : null}
        </div>
      ) : null}
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} 保存
      </Button>
    </div>
  )
}

function Gauge2({ label, remaining, limit }: { label: string; remaining: number; limit: number }) {
  const pct = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{fmtTok(remaining)} / {fmtTok(limit)}</span>
      </div>
      <Progress value={pct} className="h-1.5" />
    </div>
  )
}

function NetworkPanel({ provider }: { provider: AIProvider }) {
  const qc = useQueryClient()
  const [proxy, setProxy] = React.useState(provider.proxy_url ?? "")
  const [extra, setExtra] = React.useState<Record<string, string>>(() => ({
    azure_deployment: provider.extra?.azure_deployment ?? "",
    azure_api_version: provider.extra?.azure_api_version ?? "",
    bedrock_region: provider.extra?.bedrock_region ?? "",
    org_id: provider.extra?.org_id ?? "",
  }))
  const [headers, setHeaders] = React.useState<{ k: string; v: string }[]>([])
  const save = useMutation({
    mutationFn: () => {
      const e: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(extra)) if (v.trim()) e[k] = v
      const hdr: Record<string, string> = {}
      for (const { k, v } of headers) if (k.trim()) hdr[k] = v
      if (Object.keys(hdr).length) e.headers = hdr
      return aiProviderService.update(provider.id, { proxy_url: proxy || undefined, extra: e })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "providers"] })
      toast.success("网络配置已更新")
    },
    onError: (err: unknown) => toast.error("保存失败", { description: (err as Error).message }),
  })
  const isAzure = (provider.base_url || "").toLowerCase().includes("azure")
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-xs">代理 ProxyURL</Label>
        <Input value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="http(s):// 或 socks5://" />
      </div>
      {isAzure && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Azure 部署名</Label>
            <Input value={extra.azure_deployment} onChange={(e) => setExtra((s) => ({ ...s, azure_deployment: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Azure API 版本</Label>
            <Input value={extra.azure_api_version} onChange={(e) => setExtra((s) => ({ ...s, azure_api_version: e.target.value }))} />
          </div>
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-xs">OpenAI Organization</Label>
        <Input value={extra.org_id} onChange={(e) => setExtra((s) => ({ ...s, org_id: e.target.value }))} placeholder="org-…（可选）" />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs">自定义请求头</Label>
          <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setHeaders((h) => [...h, { k: "", v: "" }])}>
            <Plus className="size-3" /> 添加
          </Button>
        </div>
        {provider.extra?.header_keys?.length ? (
          <p className="text-[11px] text-muted-foreground">已配置：{provider.extra.header_keys.join(", ")}（值已隐藏，重填以覆盖）</p>
        ) : null}
        {headers.map((h, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={h.k} onChange={(e) => setHeaders((arr) => arr.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} placeholder="Header 名" className="h-8 text-xs" />
            <Input value={h.v} onChange={(e) => setHeaders((arr) => arr.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} placeholder="值" className="h-8 text-xs" />
            <button type="button" onClick={() => setHeaders((arr) => arr.filter((_, j) => j !== i))} className="text-muted-foreground/40 hover:text-destructive">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} 保存
      </Button>
    </div>
  )
}

function UsagePanel({ providerId }: { providerId: number }) {
  const [days, setDays] = React.useState(30)
  const q = useQuery({
    queryKey: ["ai", "provider-usage", providerId, days],
    queryFn: () => aiProviderService.usage(providerId, days),
  })
  const t = q.data?.totals
  const trend = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const b of q.data?.buckets ?? []) m.set(b.day, (m.get(b.day) || 0) + b.cost_micros)
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, cost]) => ({ day: day.slice(5), cost: cost / 1_000_000 }))
  }, [q.data])
  const chartConfig: ChartConfig = { cost: { label: "成本 (USD)", color: "var(--chart-1)" } }
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Segmented value={String(days)} onChange={(v) => setDays(Number(v))} options={[7, 30, 90].map((d) => ({ v: String(d), label: `${d}天` }))} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat icon={Coins} label="成本" value={t ? `~${fmtCost(t.cost_micros)}` : "—"} />
        <Stat icon={Activity} label="输入/输出" value={t ? `${fmtTok(t.input_tokens)}/${fmtTok(t.output_tokens)}` : "—"} />
        <Stat icon={Cpu} label="轮次" value={t ? String(t.messages) : "—"} />
      </div>
      <div className="rounded-xl border bg-card p-4">
        <div className="eyebrow mb-3">每日成本趋势</div>
        {trend.length === 0 ? (
          <div className="flex h-[140px] items-center justify-center text-sm text-muted-foreground">{q.isLoading ? "加载中…" : "暂无用量数据"}</div>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[160px] w-full">
            <AreaChart data={trend} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="fill-pcost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-cost)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--color-cost)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/50" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} className="text-[10px]" />
              <YAxis hide />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="cost" stroke="var(--color-cost)" strokeWidth={2} fill="url(#fill-pcost)" />
            </AreaChart>
          </ChartContainer>
        )}
      </div>
    </div>
  )
}
