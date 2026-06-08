"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Check, ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, Sparkles, Star, X,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { MaybeVirtualList } from "@/lib/ai/maybe-virtual"
import { AppIcon } from "@/components/icons/app-icon"
import { CapabilityBadges } from "./capability-badges"
import { fmtPrice } from "@/lib/ai/usage-format"
import { aiProviderService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import type { AIModel, AIProviderPreset, ProviderKind } from "@/lib/api/types"

const STEPS = ["基本", "凭据", "拨测", "模型"]

const KIND_OPTIONS: { v: ProviderKind; label: string }[] = [
  { v: "openai", label: "OpenAI" },
  { v: "anthropic", label: "Anthropic Claude" },
  { v: "openai_compatible", label: "OpenAI 兼容（DeepSeek / 硅基流动 / Kimi…）" },
  { v: "gemini", label: "Google Gemini" },
]

interface Draft {
  name: string
  kind: ProviderKind
  base_url: string
  api_key: string
  proxy_url: string
  enabled: boolean
  is_global: boolean
  extra: Record<string, string>
  default_model: string
}

function initDraft(preset: AIProviderPreset | null): Draft {
  if (!preset) {
    return {
      name: "", kind: "openai_compatible", base_url: "", api_key: "",
      proxy_url: "", enabled: true, is_global: false, extra: {}, default_model: "",
    }
  }
  return {
    name: preset.name,
    kind: preset.kind,
    base_url: preset.base_url ?? "",
    api_key: preset.category === "local" ? "local" : "",
    proxy_url: "",
    enabled: true,
    is_global: false,
    extra: {},
    default_model: preset.models?.[0]?.id ?? "",
  }
}

function mergeModelLists(preset: AIModel[], live: AIModel[]): AIModel[] {
  const map = new Map<string, AIModel>()
  for (const m of preset) map.set(m.id, m)
  for (const m of live) if (!map.has(m.id)) map.set(m.id, m)
  return [...map.values()]
}

// ProviderSetupWizard is the guided, low-input "add provider" flow: pick a preset
// (or custom) → paste a key → live test → review/select models → create. Most
// fields auto-fill from the catalog so the operator mostly confirms.
export function ProviderSetupWizard({
  open,
  preset,
  canBeGlobal,
  onClose,
  onCreated,
}: {
  open: boolean
  preset: AIProviderPreset | null
  canBeGlobal: boolean
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const qc = useQueryClient()
  const [step, setStep] = React.useState(0)
  const [draft, setDraft] = React.useState<Draft>(() => initDraft(preset))
  const [showKey, setShowKey] = React.useState(false)
  const [candidates, setCandidates] = React.useState<AIModel[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  // Reset whenever the sheet (re)opens with a (possibly new) preset.
  React.useEffect(() => {
    if (!open) return
    const d = initDraft(preset)
    setDraft(d)
    setStep(0)
    setShowKey(false)
    setCandidates(preset?.models ?? [])
    setSelected(new Set((preset?.models ?? []).map((m) => m.id)))
  }, [open, preset])

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }))

  const test = useMutation({
    mutationFn: () =>
      aiProviderService.testDraft({
        kind: draft.kind, name: draft.name, base_url: draft.base_url,
        api_key: draft.api_key, proxy_url: draft.proxy_url, extra: draft.extra,
      }),
  })
  const discover = useMutation({
    mutationFn: () =>
      aiProviderService.discoverModels({
        kind: draft.kind, base_url: draft.base_url,
        api_key: draft.api_key, proxy_url: draft.proxy_url, extra: draft.extra,
      }),
    onSuccess: (r) => {
      const merged = mergeModelLists(preset?.models ?? candidates, r.models ?? [])
      setCandidates(merged)
    },
  })
  const create = useMutation({
    mutationFn: () => {
      const models = candidates.filter((m) => selected.has(m.id))
      return aiProviderService.create({
        name: draft.name,
        kind: draft.kind,
        base_url: draft.base_url || undefined,
        api_key: draft.api_key,
        proxy_url: draft.proxy_url || undefined,
        is_global: draft.is_global,
        enabled: draft.enabled,
        default_model: draft.default_model || undefined,
        extra: Object.keys(draft.extra).length ? draft.extra : undefined,
        models,
      })
    },
    onSuccess: (r) => {
      toast.success("提供商已创建")
      qc.invalidateQueries({ queryKey: ["ai", "providers"] })
      onCreated(r.id)
    },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  // Fire test / discovery when their steps become active.
  React.useEffect(() => {
    if (open && step === 2) test.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, open])
  React.useEffect(() => {
    if (open && step === 3) discover.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, open])

  const needsBaseURL = draft.kind === "openai_compatible" || preset?.needs_base_url
  const stepValid = (s: number): boolean => {
    if (s === 0) return draft.name.trim() !== "" && (!needsBaseURL || draft.base_url.trim() !== "")
    if (s === 1) {
      if (draft.api_key.trim() === "") return false
      for (const f of preset?.extra_fields ?? []) {
        if (f.required && !(draft.extra[f.key] ?? "").trim()) return false
      }
      return true
    }
    return true
  }

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1))
  const back = () => setStep((s) => Math.max(0, s - 1))

  const availableIds = React.useMemo(() => new Set(candidates.map((m) => m.id)), [candidates])
  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {/* Header + stepper */}
        <div className="border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <AppIcon icon={preset?.icon} size={22} fallback="lucide:sparkles" />
            <h2 className="text-base font-semibold">{preset ? `接入 ${preset.name}` : "新增自定义提供商"}</h2>
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            {STEPS.map((label, i) => (
              <React.Fragment key={label}>
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full text-[11px] font-medium",
                      i < step && "bg-primary text-on-primary",
                      i === step && "bg-primary/15 text-primary ring-1 ring-primary/40",
                      i > step && "bg-muted text-muted-foreground",
                    )}
                  >
                    {i < step ? <Check className="size-3" /> : i + 1}
                  </span>
                  <span className={cn("text-xs", i === step ? "font-medium text-foreground" : "text-muted-foreground")}>
                    {label}
                  </span>
                </div>
                {i < STEPS.length - 1 && <div className="h-px w-3 bg-border" />}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === 0 && (
            <div className="space-y-3">
              {preset ? (
                <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
                  <AppIcon icon={preset.icon} size={32} fallback="lucide:sparkles" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{preset.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{KIND_OPTIONS.find((k) => k.v === preset.kind)?.label}</div>
                  </div>
                </div>
              ) : (
                <Field label="类型">
                  <Select value={draft.kind} onValueChange={(v) => patch({ kind: v as ProviderKind })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {KIND_OPTIONS.map((k) => (
                        <SelectItem key={k.v} value={k.v}>{k.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label="名称 *">
                <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="给这个提供商起个名字" />
              </Field>
              {needsBaseURL && (
                <Field label="BaseURL *" hint={preset?.base_url ? "已按预设填好，可按需修改" : undefined}>
                  <Input value={draft.base_url} onChange={(e) => patch({ base_url: e.target.value })} placeholder="https://api.example.com/v1" />
                </Field>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <Field label="API Key *" hint={preset?.key_help}>
                <div className="relative">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={draft.api_key}
                    onChange={(e) => patch({ api_key: e.target.value })}
                    placeholder="sk-..."
                    className="pr-9 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </Field>
              {preset?.docs_url && (
                <a href={preset.docs_url} target="_blank" rel="noreferrer" className="inline-flex text-xs text-primary hover:underline">
                  在哪里获取密钥 →
                </a>
              )}
              {(preset?.extra_fields ?? []).map((f) => (
                <Field key={f.key} label={f.label + (f.required ? " *" : "")}>
                  <Input
                    value={draft.extra[f.key] ?? ""}
                    onChange={(e) => patch({ extra: { ...draft.extra, [f.key]: e.target.value } })}
                    placeholder={f.placeholder}
                  />
                </Field>
              ))}

              <Collapsible>
                <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                  高级（BaseURL / 代理 / 可见性）
                  <ChevronRight className="size-3.5 transition-transform data-[state=open]:rotate-90" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-3">
                  {!needsBaseURL && (
                    <Field label="BaseURL" hint="留空使用官方默认">
                      <Input value={draft.base_url} onChange={(e) => patch({ base_url: e.target.value })} placeholder="官方默认" />
                    </Field>
                  )}
                  <Field label="代理 ProxyURL" hint="http(s):// 或 socks5://">
                    <Input value={draft.proxy_url} onChange={(e) => patch({ proxy_url: e.target.value })} placeholder="可选" />
                  </Field>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={draft.enabled} onCheckedChange={(v) => patch({ enabled: v })} /> 启用
                    </label>
                    {canBeGlobal && (
                      <label className="flex items-center gap-2 text-sm">
                        <Switch checked={draft.is_global} onCheckedChange={(v) => patch({ is_global: v })} /> 全局可见
                      </label>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">正在验证凭据与可达性…</p>
              <TestResultCard
                pending={test.isPending}
                result={test.data}
                error={test.error as Error | null}
                onRetry={() => test.mutate()}
              />
              <p className="text-xs text-muted-foreground">拨测失败也可以继续创建（稍后可在详情里重试）。</p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">
                  选择启用的模型
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">已选 {selected.size} / {candidates.length}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Set(availableIds))}>全选</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Set())}>清空</Button>
                </div>
              </div>
              {discover.isPending && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> 正在发现可用模型…
                </div>
              )}
              {candidates.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  未发现模型，可先创建后在详情里手动添加
                </div>
              ) : (
                <MaybeVirtualList
                  items={candidates}
                  threshold={30}
                  height="min(46vh, 24rem)"
                  className="space-y-1.5"
                  itemKey={(m) => m.id}
                  renderItem={(m) => (
                    <ModelSelectRow
                      model={m}
                      checked={selected.has(m.id)}
                      isDefault={draft.default_model === m.id}
                      onToggle={() => toggle(m.id)}
                      onDefault={() => patch({ default_model: m.id })}
                    />
                  )}
                />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t bg-secondary/40 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={step === 0 ? onClose : back}>
            {step === 0 ? <><X className="size-4" /> 取消</> : <><ChevronLeft className="size-4" /> 上一步</>}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button size="sm" onClick={next} disabled={!stepValid(step)}>
              下一步 <ChevronRight className="size-4" />
            </Button>
          ) : (
            <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} 完成创建
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function TestResultCard({
  pending, result, error, onRetry,
}: {
  pending: boolean
  result?: { ok: boolean; reachable?: boolean; latency_ms?: number; model_count?: number; sample_model?: string; error?: string }
  error: Error | null
  onRetry: () => void
}) {
  if (pending) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-card p-3 text-sm">
        <Loader2 className="size-4 animate-spin text-muted-foreground" /> 拨测中…
      </div>
    )
  }
  const ok = result?.ok && result.reachable !== false
  const msg = result?.error || error?.message
  return (
    <div className={cn("rounded-lg border p-3", ok ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5")}>
      <div className="flex items-center gap-2 text-sm font-medium">
        {ok ? <Check className="size-4 text-success" /> : <X className="size-4 text-destructive" />}
        {ok ? "连接正常" : "连接失败"}
        {ok && typeof result?.latency_ms === "number" && (
          <span className="font-normal text-muted-foreground">· {result.latency_ms}ms</span>
        )}
        {ok && typeof result?.model_count === "number" && (
          <Badge variant="outline" className="ml-auto text-[10px]">{result.model_count} 个模型</Badge>
        )}
      </div>
      {!ok && msg && <p className="mt-1.5 line-clamp-3 break-all text-xs text-muted-foreground">{msg}</p>}
      {!ok && (
        <Button variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={onRetry}>重试</Button>
      )}
    </div>
  )
}

function ModelSelectRow({
  model, checked, isDefault, onToggle, onDefault,
}: {
  model: AIModel
  checked: boolean
  isDefault: boolean
  onToggle: () => void
  onDefault: () => void
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border p-2 transition-colors",
        checked ? "border-primary/25 bg-primary/10" : "border-border hover:bg-accent",
      )}
    >
      <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border", checked ? "border-primary bg-primary text-on-primary" : "border-muted-foreground/40")}>
          {checked && <Check className="size-3" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{model.id}</span>
          {model.context_window ? (
            <span className="text-[10px] text-muted-foreground">{Math.round(model.context_window / 1000)}k ctx · 入 {fmtPrice(model.pricing?.in_per_mtok)}</span>
          ) : null}
        </span>
      </button>
      <CapabilityBadges model={model} />
      <button
        type="button"
        onClick={onDefault}
        title="设为默认模型"
        className={cn("shrink-0 rounded p-1", isDefault ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground")}
      >
        <Star className={cn("size-3.5", isDefault && "fill-current")} />
      </button>
    </div>
  )
}
