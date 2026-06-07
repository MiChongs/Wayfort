"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"
import {
  Activity,
  Archive,
  Bot,
  Box,
  ChevronRight,
  FileText,
  History,
  LayoutDashboard,
  Loader2,
  Lock,
  Mail,
  Monitor,
  Network,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Waypoints,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { settingsService } from "@/lib/api/services"
import type { IntegrationStatus, SettingField, SettingsGroup } from "@/lib/api/types"
import { useAccess } from "@/lib/hooks/use-access"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SettingFieldRow } from "@/components/settings/field-control"
import { IntegrationCard } from "@/components/settings/integration-card"

type IconType = React.ComponentType<{ className?: string }>

const GROUP_ICONS: Record<string, IconType> = {
  "layout-dashboard": LayoutDashboard,
  "shield-check": ShieldCheck,
  bot: Bot,
  mail: Mail,
  monitor: Monitor,
  network: Network,
  activity: Activity,
  waypoints: Waypoints,
  box: Box,
  archive: Archive,
  "file-text": FileText,
}

const OVERVIEW: SettingsGroup = {
  id: "overview",
  title: "概览",
  subtitle: "外部集成连通性与最近的配置变更",
  icon: "layout-dashboard",
  order: 0,
}

export default function SettingsPage() {
  const access = useAccess()
  const qc = useQueryClient()
  const schemaQ = useQuery({ queryKey: ["settings", "schema"], queryFn: settingsService.schema })

  const [activeGroup, setActiveGroup] = React.useState("overview")
  const [draft, setDraft] = React.useState<Record<string, unknown>>({})
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [testing, setTesting] = React.useState<string | null>(null)
  const [liveProbe, setLiveProbe] = React.useState<Record<string, IntegrationStatus>>({})

  const dirtyCount = Object.keys(draft).length

  const fieldByKey = React.useMemo(() => {
    const m: Record<string, SettingField> = {}
    for (const f of schemaQ.data?.fields ?? []) m[f.key] = f
    return m
  }, [schemaQ.data])

  const valueOf = React.useCallback(
    (f: SettingField): unknown => (f.key in draft ? draft[f.key] : f.value),
    [draft],
  )

  const dependActive = React.useCallback(
    (f: SettingField): boolean => {
      if (!f.depends_on) return true
      const dep = fieldByKey[f.depends_on]
      if (!dep) return true
      const dv = dep.key in draft ? draft[dep.key] : dep.value
      if (f.depends_value === "*") return dv != null && dv !== false && String(dv) !== ""
      return String(dv) === f.depends_value
    },
    [fieldByKey, draft],
  )

  const save = useMutation({
    mutationFn: () => settingsService.update(draft),
    onSuccess: (res) => {
      const restart = res.restart_keys ?? []
      setDraft({})
      qc.invalidateQueries({ queryKey: ["settings"] })
      if (restart.length > 0) {
        const labels = restart.map((k) => fieldByKey[k]?.label ?? k).join("、")
        toast.success("已保存", { description: `以下项需重启网关后生效：${labels}` })
      } else {
        toast.success("已保存并即时生效")
      }
    },
    onError: (e: { message?: string }) => toast.error("保存失败", { description: e.message }),
  })

  const resetKey = useMutation({
    mutationFn: (key: string) => settingsService.reset([key]),
    onSuccess: (_d, key) => {
      setDraft((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      qc.invalidateQueries({ queryKey: ["settings"] })
      toast.success("已重置为默认值")
    },
    onError: (e: { message?: string }) => toast.error("重置失败", { description: e.message }),
  })

  const runTest = async (id: string) => {
    setTesting(id)
    try {
      const res = await settingsService.test(id)
      setLiveProbe((p) => ({ ...p, [id]: res.integration }))
      if (res.integration.state === "healthy") toast.success(`${res.integration.title} 连接正常`)
      else if (res.integration.state === "error")
        toast.error(`${res.integration.title} 连接异常`, { description: res.integration.detail })
    } catch (e) {
      toast.error("测试失败", { description: (e as { message?: string }).message })
    } finally {
      setTesting(null)
    }
  }

  if (!access.loading && !access.isSuperadmin) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
          <Lock className="h-6 w-6" />
        </span>
        <h1 className="display-title text-2xl">仅超级管理员可访问</h1>
        <p className="max-w-sm text-sm text-muted-foreground">系统设置会改写认证策略、密钥处理与各协议网关，已对你的角色隐藏。</p>
      </div>
    )
  }

  const groups: SettingsGroup[] = [OVERVIEW, ...(schemaQ.data?.groups ?? []).slice().sort((a, b) => a.order - b.order)]
  const allIntegrations: IntegrationStatus[] = (schemaQ.data?.integrations ?? []).map((i) => liveProbe[i.id] ?? i)

  return (
    <TooltipProvider delayDuration={200}>
      <div className="p-6">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="display-title flex items-center gap-2.5 text-3xl">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary">
                <SlidersHorizontal className="h-5 w-5" />
              </span>
              系统设置
            </h1>
            <p className="max-w-xl text-sm text-muted-foreground">
              网关的运行配置集中在此，改动落库持久化。标注「重启生效」之外的项即时应用，敏感凭据加密存储。
            </p>
          </div>
        </header>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[226px_minmax(0,1fr)]">
          {/* Left nav */}
          <nav className="lg:sticky lg:top-6 lg:self-start">
            <div className="space-y-0.5">
              {groups.map((g) => {
                const Icon = GROUP_ICONS[g.icon] ?? SlidersHorizontal
                const on = activeGroup === g.id
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setActiveGroup(g.id)}
                    className={cn(
                      "group relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      on
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {on && (
                      <motion.span
                        layoutId="settings-nav-active"
                        className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary"
                      />
                    )}
                    <Icon className={cn("h-[18px] w-[18px] shrink-0", on ? "text-primary" : "text-muted-foreground/70")} />
                    <span className="truncate">{g.title}</span>
                  </button>
                )
              })}
            </div>
          </nav>

          {/* Right panel */}
          <div className="min-w-0">
            {schemaQ.isLoading ? (
              <PanelSkeleton />
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeGroup}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                >
                  {activeGroup === "overview" ? (
                    <OverviewPanel
                      integrations={allIntegrations}
                      testing={testing}
                      onTest={runTest}
                      fieldCount={schemaQ.data?.fields.length ?? 0}
                      overriddenCount={(schemaQ.data?.fields ?? []).filter((f) => f.overridden).length}
                    />
                  ) : (
                    <GroupPanel
                      group={groups.find((g) => g.id === activeGroup)!}
                      fields={(schemaQ.data?.fields ?? []).filter((f) => f.group === activeGroup)}
                      integrations={allIntegrations.filter((i) => i.group === activeGroup)}
                      showAdvanced={showAdvanced}
                      onToggleAdvanced={setShowAdvanced}
                      valueOf={valueOf}
                      draft={draft}
                      dependActive={dependActive}
                      testing={testing}
                      onTest={runTest}
                      onChange={(k, v) => setDraft((p) => ({ ...p, [k]: v }))}
                      onReset={(k) => resetKey.mutate(k)}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            )}

            {/* Save bar */}
            <AnimatePresence>
              {dirtyCount > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 16 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="sticky bottom-4 z-10 mt-6"
                >
                  <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-[0_4px_24px_rgba(20,20,19,0.10)] backdrop-blur">
                    <span className="text-sm text-muted-foreground">
                      <b className="font-medium text-foreground tabular-nums">{dirtyCount}</b> 项未保存的更改
                    </span>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => setDraft({})}>
                        <RotateCcw className="h-3.5 w-3.5" /> 放弃
                      </Button>
                      <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        保存更改
                      </Button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

function GroupPanel({
  group,
  fields,
  integrations,
  showAdvanced,
  onToggleAdvanced,
  valueOf,
  draft,
  dependActive,
  testing,
  onTest,
  onChange,
  onReset,
}: {
  group: SettingsGroup
  fields: SettingField[]
  integrations: IntegrationStatus[]
  showAdvanced: boolean
  onToggleAdvanced: (v: boolean) => void
  valueOf: (f: SettingField) => unknown
  draft: Record<string, unknown>
  dependActive: (f: SettingField) => boolean
  testing: string | null
  onTest: (id: string) => void
  onChange: (k: string, v: unknown) => void
  onReset: (k: string) => void
}) {
  const common = fields.filter((f) => !f.advanced)
  const advanced = fields.filter((f) => f.advanced)
  const Icon = GROUP_ICONS[group.icon] ?? SlidersHorizontal

  return (
    <section className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        <div className="space-y-0.5">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{group.title}</h2>
          {group.subtitle && <p className="text-sm text-muted-foreground">{group.subtitle}</p>}
        </div>
      </div>

      {integrations.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {integrations.map((i) => (
            <IntegrationCard key={i.id} integration={i} testing={testing === i.id} onTest={() => onTest(i.id)} />
          ))}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card px-5">
        {common.length === 0 && advanced.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">该分区没有可调项</p>
        ) : (
          <div>
            {common.map((f) => (
              <SettingFieldRow
                key={f.key}
                field={f}
                value={valueOf(f)}
                dirty={f.key in draft}
                active={dependActive(f)}
                onChange={(v) => onChange(f.key, v)}
                onReset={() => onReset(f.key)}
              />
            ))}
          </div>
        )}

        {advanced.length > 0 && (
          <>
            <div className="flex items-center justify-between py-3.5">
              <div className="flex items-center gap-2">
                <Label htmlFor={`adv-${group.id}`} className="text-xs font-medium text-muted-foreground">
                  显示高级选项
                </Label>
                <span className="rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground tabular-nums">
                  {advanced.length}
                </span>
              </div>
              <Switch id={`adv-${group.id}`} checked={showAdvanced} onCheckedChange={onToggleAdvanced} />
            </div>
            <AnimatePresence initial={false}>
              {showAdvanced && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <Separator className="mb-1" />
                  {advanced.map((f) => (
                    <SettingFieldRow
                      key={f.key}
                      field={f}
                      value={valueOf(f)}
                      dirty={f.key in draft}
                      active={dependActive(f)}
                      onChange={(v) => onChange(f.key, v)}
                      onReset={() => onReset(f.key)}
                    />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
    </section>
  )
}

function OverviewPanel({
  integrations,
  testing,
  onTest,
  fieldCount,
  overriddenCount,
}: {
  integrations: IntegrationStatus[]
  testing: string | null
  onTest: (id: string) => void
  fieldCount: number
  overriddenCount: number
}) {
  const auditsQ = useQuery({ queryKey: ["settings", "audits"], queryFn: settingsService.audits })
  const audits = auditsQ.data?.audits ?? []

  return (
    <section className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="可调项" value={fieldCount} />
        <Stat label="已自定义" value={overriddenCount} accent />
        <Stat label="外部集成" value={integrations.length} />
        <Stat
          label="连接正常"
          value={integrations.filter((i) => i.state === "healthy").length}
        />
      </div>

      <div className="space-y-3">
        <div className="eyebrow">外部集成</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {integrations.map((i) => (
            <IntegrationCard key={i.id} integration={i} testing={testing === i.id} onTest={() => onTest(i.id)} />
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="eyebrow flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" /> 最近变更
        </div>
        <div className="rounded-xl border border-border bg-card">
          {audits.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">还没有配置变更记录</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {audits.slice(0, 12).map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-muted-foreground">{a.key}</span>
                    <span className="mx-2 text-muted-foreground/60">→</span>
                    <span className="font-medium">{a.new_value}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{a.actor_name || `#${a.actor_id}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className={cn("display-title text-2xl tabular-nums", accent && value > 0 && "text-primary")}>{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function PanelSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-56" />
        </div>
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  )
}
