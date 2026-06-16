"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  BookOpen,
  Bot,
  Brain,
  ClipboardList,
  Cpu,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  User,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { EmptyState } from "@/components/common/empty-state"
import { aiAgentService, aiKnowledgeService, aiProviderService } from "@/lib/api/services"
import { AgentAvatar } from "@/components/ai/agent-avatar"
import { IconPicker } from "@/components/icons/icon-picker"
import { ToolMultiSelect } from "@/components/ai/agent-form/tool-multiselect"
import { KbMultiSelect } from "@/components/ai/agent-form/kb-multiselect"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { cn } from "@/lib/utils"
import type { AIAgent, AIKnowledgeBase, AIProvider, AITool, PermissionMode } from "@/lib/api/types"

function parseList(s: string): string[] {
  if (!s) return []
  try {
    return JSON.parse(s) as string[]
  } catch {
    return s.split(",").filter(Boolean)
  }
}
function parseNumList(s?: string): number[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(Number).filter((n) => !Number.isNaN(n)) : []
  } catch {
    return []
  }
}

// Permission modes carry real safety weight (see internal/ai/tools/gate.go):
// they decide whether dangerous tool calls run, get planned, or need approval.
// Spelled out in plain language so picking one isn't a guess.
const PERMISSION_MODES = [
  {
    value: "plan" as const,
    label: "规划模式",
    short: "规划",
    icon: ClipboardList,
    hint: "只读工具照常执行；删除 / 改配置等危险操作只演练不落地——先看清它打算怎么做。",
  },
  {
    value: "normal" as const,
    label: "标准模式",
    short: "标准",
    icon: ShieldCheck,
    recommended: true,
    hint: "只读工具直接执行；危险操作逐个征求你同意后再做。",
  },
  {
    value: "bypass" as const,
    label: "放行模式",
    short: "放行",
    icon: Zap,
    hint: "所有工具（含危险操作）全自动执行，不再询问。仅在可信场景使用。",
  },
]

function ModeBadge({ mode }: { mode: PermissionMode }) {
  const m = PERMISSION_MODES.find((x) => x.value === mode) ?? PERMISSION_MODES[1]
  const Icon = m.icon
  return (
    <Badge variant={mode === "bypass" ? "warning" : "soft"} className="gap-1 rounded-full font-normal">
      <Icon className="size-3" /> {m.short}
    </Badge>
  )
}

// ============================================================================
export default function AIAgentsPage() {
  const qc = useQueryClient()
  const me = useCurrentUser()
  const list = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })
  const providers = useQuery({ queryKey: ["ai", "providers"], queryFn: aiProviderService.list })
  const tools = useQuery({ queryKey: ["ai", "tools"], queryFn: aiAgentService.tools })
  const kbs = useQuery({ queryKey: ["ai", "knowledge-bases"], queryFn: aiKnowledgeService.listKBs })

  const remove = useMutation({
    mutationFn: (id: number) => aiAgentService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "agents"] })
      toast.success("已删除")
    },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })

  const [active, setActive] = React.useState<{ mode: "create" | "edit"; agent?: AIAgent } | null>(null)
  const [search, setSearch] = React.useState("")

  const all = list.data?.agents ?? []
  const agents = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return all
    return all.filter((a) =>
      [a.name, a.description, a.default_model].filter(Boolean).join(" ").toLowerCase().includes(q),
    )
  }, [all, search])

  const onDelete = async (a: AIAgent) => {
    const ok = await confirmDialog({
      title: `删除「${a.name}」？`,
      description: "该 Agent 将不再可用，已有对话不受影响。此操作不可恢复。",
      destructive: true,
    })
    if (ok) remove.mutate(a.id)
  }

  return (
    <div className="@container p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Bot className="size-5" /> AI Agent
          </h1>
          <p className="text-sm text-muted-foreground">
            每个 Agent 是一套人格：系统指令 + 可用工具 + 模型与护栏。把它用在对话里替你干活。
          </p>
        </div>
        <Button onClick={() => setActive({ mode: "create" })}>
          <Plus className="size-4" /> 新建 Agent
        </Button>
      </div>

      {!list.isLoading && all.length > 0 && (
        <div className="relative max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="搜索 Agent…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      )}

      {list.isLoading ? (
        <div className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <div className="rounded-xl border">
          <EmptyState
            icon={Bot}
            title="还没有 Agent"
            description="新建一个 Agent：给它一段人格指令，挑选它能用的工具，就能在对话里使用了。"
            action={
              <Button onClick={() => setActive({ mode: "create" })}>
                <Plus className="size-4" /> 新建 Agent
              </Button>
            }
          />
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border">
          <EmptyState icon={Search} title="没有匹配的 Agent" description={`没有找到包含「${search}」的 Agent。`} />
        </div>
      ) : (
        <div className="grid gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              toolCount={parseList(a.allowed_tools).length}
              kbCount={parseNumList(a.knowledge_base_ids).length}
              onEdit={() => setActive({ mode: "edit", agent: a })}
              onDelete={() => onDelete(a)}
            />
          ))}
        </div>
      )}

      <AgentSheet
        active={active}
        providers={providers.data?.providers ?? []}
        tools={tools.data?.tools ?? []}
        knowledgeBases={kbs.data?.knowledge_bases ?? []}
        canBeGlobal={!!me?.adm}
        onClose={() => setActive(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["ai", "agents"] })
          setActive(null)
        }}
      />
    </div>
  )
}

// ----- agent card -----------------------------------------------------------
function AgentCard({
  agent: a,
  toolCount,
  kbCount,
  onEdit,
  onDelete,
}: {
  agent: AIAgent
  toolCount: number
  kbCount: number
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-xl border bg-card", !a.enabled && "opacity-75")}>
      <button
        type="button"
        onClick={onEdit}
        className="flex-1 cursor-pointer p-4 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <div className="flex items-start gap-3">
          <AgentAvatar size="lg" agent={a} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="truncate font-medium">{a.name}</span>
              {a.scope === "global" ? (
                <Badge variant="soft" className="gap-1 rounded-full">
                  <Globe className="size-3" /> 全局
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 rounded-full">
                  <User className="size-3" /> 个人
                </Badge>
              )}
              {!a.enabled && <Badge variant="secondary">已停用</Badge>}
            </div>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{a.description || "暂无简介"}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="gap-1 rounded-full font-normal">
            <Cpu className="size-3" /> {a.default_model || "默认模型"}
          </Badge>
          <ModeBadge mode={a.permission_mode} />
          {toolCount > 0 && (
            <Badge variant="soft" className="gap-1 rounded-full font-normal">
              <Wrench className="size-3" /> {toolCount} 工具
            </Badge>
          )}
          {kbCount > 0 && (
            <Badge variant="soft" className="gap-1 rounded-full font-normal">
              <BookOpen className="size-3" /> {kbCount} 知识库
            </Badge>
          )}
          {a.memory_enabled && (
            <Badge variant="soft" className="gap-1 rounded-full font-normal">
              <Brain className="size-3" /> 记忆
            </Badge>
          )}
          {a.is_sub_agent && (
            <Badge variant="soft" className="gap-1 rounded-full font-normal">
              <Workflow className="size-3" /> 子 Agent
            </Badge>
          )}
        </div>
      </button>

      <div className="flex items-center justify-end gap-1 border-t bg-muted/20 px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-4" /> 编辑
        </Button>
        <Button variant="ghost" size="icon" aria-label="删除" onClick={onDelete}>
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>
    </div>
  )
}

// ----- create / edit sheet --------------------------------------------------
const CREATE_DEFAULTS: Partial<AIAgent> = {
  name: "",
  description: "",
  scope: "personal",
  system_prompt: "",
  default_model: "",
  permission_mode: "normal",
  max_iterations: 20,
  is_sub_agent: false,
  allowed_tools: "[]",
  enabled: true,
}

function AgentSheet({
  active,
  providers,
  tools,
  knowledgeBases,
  canBeGlobal,
  onClose,
  onSaved,
}: {
  active: { mode: "create" | "edit"; agent?: AIAgent } | null
  providers: AIProvider[]
  tools: AITool[]
  knowledgeBases: AIKnowledgeBase[]
  canBeGlobal: boolean
  onClose: () => void
  onSaved: () => void
}) {
  // Keep the last opened payload so content stays stable through the close
  // animation (active goes null the instant it starts closing).
  const [snap, setSnap] = React.useState(active)
  React.useEffect(() => {
    if (active) setSnap(active)
  }, [active])

  const [a, setA] = React.useState<Partial<AIAgent>>(CREATE_DEFAULTS)
  const [selectedTools, setSelectedTools] = React.useState<string[]>([])
  const [selectedKBs, setSelectedKBs] = React.useState<number[]>([])

  React.useEffect(() => {
    if (!active) return
    if (active.mode === "edit" && active.agent) {
      setA({ ...active.agent })
      setSelectedTools(parseList(active.agent.allowed_tools))
      setSelectedKBs(parseNumList(active.agent.knowledge_base_ids))
    } else {
      setA(CREATE_DEFAULTS)
      setSelectedTools([])
      setSelectedKBs([])
    }
  }, [active])

  const isCreate = snap?.mode === "create"
  const agent = snap?.agent

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...a,
        allowed_tools: JSON.stringify(selectedTools),
        knowledge_base_ids: JSON.stringify(selectedKBs),
      }
      return isCreate ? aiAgentService.create(body) : aiAgentService.update(agent!.id, body)
    },
    onSuccess: () => {
      onSaved()
      toast.success(isCreate ? "已创建 Agent" : "已保存")
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  const canSave = !!a.name?.trim() && !!a.system_prompt?.trim()

  const set = (patch: Partial<AIAgent>) => setA((prev) => ({ ...prev, ...patch }))

  return (
    <Sheet open={!!active} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="space-y-1 border-b px-6 pb-4 pt-6">
          <SheetTitle className="flex items-center gap-2">
            {isCreate ? <Plus className="size-4" /> : <Pencil className="size-4" />}
            {isCreate ? "新建 Agent" : `编辑「${agent?.name}」`}
          </SheetTitle>
          <SheetDescription>
            {isCreate ? "给它一段人格指令，挑好工具与护栏。" : "保存后立即对所有未来对话生效。"}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 px-6 py-5">
            {/* 身份 */}
            <Section title="身份" hint="一眼能认出这个 Agent。">
              <div className="flex items-center gap-4 rounded-lg border bg-muted/30 p-3">
                <AgentAvatar size="lg" agent={{ name: a.name || "", icon: a.icon }} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label className="text-xs text-muted-foreground">头像图标</Label>
                  <IconPicker value={a.icon || ""} onChange={(t) => set({ icon: t })} placeholder="默认用名称首字母" />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="名称" required>
                  <Input value={a.name || ""} onChange={(e) => set({ name: e.target.value })} placeholder="如：运维助手" />
                </Field>
                <Field label="可见范围">
                  <Select value={a.scope} onValueChange={(v) => set({ scope: v as "global" | "personal" })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">个人 · 仅自己可见</SelectItem>
                      {canBeGlobal && <SelectItem value="global">全局 · 所有用户可见</SelectItem>}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="一句话简介">
                <Input
                  value={a.description || ""}
                  onChange={(e) => set({ description: e.target.value })}
                  placeholder="它擅长什么、什么时候用"
                />
              </Field>
            </Section>

            <Separator />

            {/* 人格与指令 */}
            <Section title="人格与指令" hint="这段话定义它的身份、语气和铁律，是一切行为的根基。">
              <Textarea
                rows={9}
                value={a.system_prompt || ""}
                onChange={(e) => set({ system_prompt: e.target.value })}
                placeholder={`你是资深 SRE 助手。\n- 调用工具前先用 list_nodes 确认目标存在\n- 写操作执行前用一句话说明你将要做什么\n- 任何不确定的事项都先用只读工具查证`}
                className="resize-y font-mono text-[13px] leading-relaxed"
              />
            </Section>

            <Separator />

            {/* 模型与采样 */}
            <Section title="模型与采样" hint="留空则跟随系统默认提供商与模型。">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="提供商">
                  <Select
                    value={a.default_provider_id ? String(a.default_provider_id) : ""}
                    onValueChange={(v) => set({ default_provider_id: Number(v) })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="系统默认" />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.display_name || p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="模型">
                  <Input
                    value={a.default_model || ""}
                    onChange={(e) => set({ default_model: e.target.value })}
                    placeholder="如 gpt-4o-mini"
                  />
                </Field>
              </div>
              <div className="grid gap-5 pt-1 sm:grid-cols-2">
                <SliderField
                  label="创造性"
                  value={a.temperature ?? 0}
                  min={0}
                  max={2}
                  step={0.1}
                  leftHint="精确稳定"
                  rightHint="发散创意"
                  onChange={(v) => set({ temperature: v })}
                />
                <SliderField
                  label="采样范围 top-p"
                  value={a.top_p ?? 0}
                  min={0}
                  max={1}
                  step={0.05}
                  leftHint="聚焦"
                  rightHint="多样"
                  onChange={(v) => set({ top_p: v })}
                />
              </div>
            </Section>

            <Separator />

            {/* 能力 */}
            <Section title="能力" hint="勾选它能调用的工具与知识库。">
              <Field label="可用工具">
                <ToolMultiSelect tools={tools} selected={selectedTools} onChange={setSelectedTools} />
              </Field>
              <Field label="知识库（RAG）" hint="挂载后可用 knowledge_search 在其中语义检索。">
                <KbMultiSelect knowledgeBases={knowledgeBases} selected={selectedKBs} onChange={setSelectedKBs} />
              </Field>
            </Section>

            <Separator />

            {/* 行为与护栏 */}
            <Section title="行为与护栏" hint="决定它能多自主地动手。">
              <Field label="执行权限">
                <div className="grid gap-2 sm:grid-cols-3">
                  {PERMISSION_MODES.map((m) => {
                    const activeMode = a.permission_mode === m.value
                    const Icon = m.icon
                    return (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => set({ permission_mode: m.value })}
                        className={cn(
                          "rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                          activeMode ? "border-primary bg-primary/[0.04] ring-1 ring-primary/40" : "hover:bg-accent",
                        )}
                      >
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          <Icon className={cn("size-4", activeMode ? "text-primary" : "text-muted-foreground")} />
                          {m.label}
                          {m.recommended && (
                            <Badge variant="soft" className="rounded-full px-1.5 text-[10px]">
                              推荐
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{m.hint}</p>
                      </button>
                    )
                  })}
                </div>
              </Field>
              {a.permission_mode === "bypass" && (
                <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  放行模式下 Agent 会自动执行删除、改配置等危险操作而不再询问，请仅在可信场景使用。
                </div>
              )}

              <Field label="最大自驱步数" hint="单个任务最多连续执行多少步工具调用。">
                <Input
                  type="number"
                  className="max-w-32"
                  value={a.max_iterations ?? 20}
                  onChange={(e) => set({ max_iterations: Number(e.target.value) })}
                />
              </Field>

              <SwitchRow
                icon={Brain}
                title="跨会话长期记忆"
                desc="记住与用户的关键事实，跨对话沿用，并开放 remember 工具。"
                checked={!!a.memory_enabled}
                onChange={(v) => set({ memory_enabled: v })}
              />
              <SwitchRow
                icon={Workflow}
                title="可作为子 Agent 被调用"
                desc="允许主 Agent 通过 call_subagent 把子任务委派给它。"
                checked={!!a.is_sub_agent}
                onChange={(v) => set({ is_sub_agent: v })}
              />
              {a.is_sub_agent && (
                <Field label="调用提示" hint="主 Agent 读这句话来判断何时委派给它。">
                  <Input
                    value={a.invocation_hint || ""}
                    onChange={(e) => set({ invocation_hint: e.target.value })}
                    placeholder="如：需要排查数据库慢查询时调用我"
                  />
                </Field>
              )}
            </Section>

            <Separator />

            <SwitchRow
              icon={Bot}
              title="启用此 Agent"
              desc="停用后它不会出现在对话的 Agent 选择里。"
              checked={a.enabled ?? true}
              onChange={(v) => set({ enabled: v })}
            />
          </div>
        </ScrollArea>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t bg-secondary/40 px-6 py-3">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {isCreate ? "创建" : "保存"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ----- form primitives ------------------------------------------------------
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  leftHint,
  rightHint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  leftHint: string
  rightHint: string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">{label}</Label>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{value.toFixed(2)}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} />
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{leftHint}</span>
        <span>{rightHint}</span>
      </div>
    </div>
  )
}

function SwitchRow({
  icon: Icon,
  title,
  desc,
  checked,
  onChange,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border bg-card p-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="shrink-0" />
    </label>
  )
}
