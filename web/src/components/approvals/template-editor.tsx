"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, GripVertical, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { approvalService, roleService } from "@/lib/api/services"
import type { ApprovalBusinessType, ApprovalStageMode, ApprovalTemplate } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { BIZ_LABELS, RISK_META, STAGE_MODE_HINTS, STAGE_MODE_LABELS } from "@/lib/approvals/meta"

// Stage shape mirrors backend approval.StageSpec.
interface Stage {
  mode: ApprovalStageMode
  role_names?: string[]
  user_ids?: number[]
  quorum_n?: number
  timeout_sec?: number
}

function parseJSON<T>(s: string | undefined, fallback: T): T {
  if (!s || !s.trim()) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

// TemplateEditorSheet — visual editor for an approval policy template. Common
// fields + a multi-stage builder cover the everyday case; an "高级" section
// exposes the raw selector / risk-promote / auto-approve JSON for power users.
// Built-in (system) templates lock their definition — only enable/priority edit.
export function TemplateEditorSheet({
  open,
  onOpenChange,
  template,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  template: ApprovalTemplate | null
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const editing = !!template
  const locked = !!template?.is_system

  const roles = useQuery({ queryKey: ["roles"], queryFn: roleService.list, enabled: open })

  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [biz, setBiz] = React.useState<ApprovalBusinessType>("asset_access")
  const [priority, setPriority] = React.useState(100)
  const [enabled, setEnabled] = React.useState(true)
  const [maxHours, setMaxHours] = React.useState(4)
  const [timeoutMin, setTimeoutMin] = React.useState(0)
  const [stages, setStages] = React.useState<Stage[]>([{ mode: "any", role_names: ["operator"] }])
  const [riskBase, setRiskBase] = React.useState("medium")
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [selectorJSON, setSelectorJSON] = React.useState("")
  const [riskPromoteJSON, setRiskPromoteJSON] = React.useState("")
  const [autoApproveJSON, setAutoApproveJSON] = React.useState("")

  // Hydrate the form whenever the sheet opens for a (different) template.
  React.useEffect(() => {
    if (!open) return
    if (template) {
      setName(template.name)
      setDescription(template.description || "")
      setBiz(template.business_type)
      setPriority(template.priority)
      setEnabled(template.enabled)
      setMaxHours(template.max_duration_sec ? +(template.max_duration_sec / 3600).toFixed(2) : 0)
      setTimeoutMin(template.default_timeout_sec ? Math.round(template.default_timeout_sec / 60) : 0)
      setStages(parseJSON<Stage[]>(template.stages, [{ mode: "any", role_names: ["operator"] }]))
      const risk = parseJSON<{ base?: string; promote?: unknown }>(template.risk_rule, {})
      setRiskBase(risk.base || "medium")
      setRiskPromoteJSON(risk.promote ? JSON.stringify(risk.promote, null, 2) : "")
      setSelectorJSON(template.selector?.trim() ? JSON.stringify(parseJSON(template.selector, {}), null, 2) : "")
      setAutoApproveJSON(template.auto_approve?.trim() ? JSON.stringify(parseJSON(template.auto_approve, {}), null, 2) : "")
    } else {
      setName("")
      setDescription("")
      setBiz("asset_access")
      setPriority(100)
      setEnabled(true)
      setMaxHours(4)
      setTimeoutMin(0)
      setStages([{ mode: "any", role_names: ["operator"] }])
      setRiskBase("medium")
      setSelectorJSON("")
      setRiskPromoteJSON("")
      setAutoApproveJSON("")
    }
    setShowAdvanced(false)
  }, [open, template])

  const save = useMutation({
    mutationFn: () => {
      // Compose risk_rule from base + optional advanced promote rules.
      const promote = riskPromoteJSON.trim() ? JSON.parse(riskPromoteJSON) : undefined
      const riskRule = JSON.stringify(promote ? { base: riskBase, promote } : { base: riskBase })
      const body = {
        name: name.trim(),
        description: description.trim(),
        business_type: biz,
        priority,
        enabled,
        max_duration_sec: Math.round(maxHours * 3600),
        default_timeout_sec: Math.round(timeoutMin * 60),
        stages: JSON.stringify(stages),
        risk_rule: riskRule,
        selector: selectorJSON.trim() ? JSON.stringify(JSON.parse(selectorJSON)) : "",
        auto_approve: autoApproveJSON.trim() ? JSON.stringify(JSON.parse(autoApproveJSON)) : "",
      }
      return editing ? approvalService.templates.update(template!.id, body) : approvalService.templates.create(body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approval", "templates"] })
      toast.success(editing ? "已保存" : "已创建模板")
      onOpenChange(false)
      onSaved()
    },
    onError: (e: { message?: string }) => toast.error(e.message || "保存失败（请检查高级 JSON 是否合法）"),
  })

  const roleNames = (roles.data?.roles ?? []).map((r) => r.name)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>{editing ? (locked ? "查看模板（内置）" : "编辑模板") : "新建审批模板"}</SheetTitle>
          <SheetDescription>
            {locked
              ? "内置模板的策略定义不可更改，但你可以启用/停用或调整优先级。"
              : "命中的请求按此模板路由审批、计算风险、并决定授权时长上限。"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* basics */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">模板名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={locked} placeholder="例如 db-write-approval" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label className="text-xs">说明</Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={locked} placeholder="一句话描述这条策略" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">业务类型</Label>
              <Select value={biz} onValueChange={(v) => setBiz(v as ApprovalBusinessType)} disabled={locked}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(BIZ_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">优先级（小者优先）</Label>
              <Input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
            <div>
              <div className="text-sm font-medium">启用</div>
              <div className="text-xs text-muted-foreground">停用后该模板不再参与匹配。</div>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {/* duration */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">授权时长上限（小时）</Label>
              <Input
                type="number"
                min={0}
                step={0.5}
                value={maxHours}
                onChange={(e) => setMaxHours(Number(e.target.value) || 0)}
                disabled={locked}
              />
              <p className="text-[11px] text-muted-foreground">0 = 不额外限制，按申请人请求。</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">单级超时（分钟）</Label>
              <Input
                type="number"
                min={0}
                value={timeoutMin}
                onChange={(e) => setTimeoutMin(Number(e.target.value) || 0)}
                disabled={locked}
              />
              <p className="text-[11px] text-muted-foreground">0 = 不超时。</p>
            </div>
          </div>

          {/* stages */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">审批阶段</Label>
              {!locked && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1"
                  onClick={() => setStages((s) => [...s, { mode: "any", role_names: [] }])}
                >
                  <Plus className="h-3.5 w-3.5" /> 添加阶段
                </Button>
              )}
            </div>
            {stages.map((st, i) => (
              <StageRow
                key={i}
                index={i}
                total={stages.length}
                stage={st}
                roles={roleNames}
                locked={locked}
                onChange={(next) => setStages((arr) => arr.map((s, j) => (j === i ? next : s)))}
                onRemove={() => setStages((arr) => arr.filter((_, j) => j !== i))}
                onMove={(dir) =>
                  setStages((arr) => {
                    const j = i + dir
                    if (j < 0 || j >= arr.length) return arr
                    const next = [...arr]
                    ;[next[i], next[j]] = [next[j], next[i]]
                    return next
                  })
                }
              />
            ))}
            {stages.length === 0 && (
              <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                至少添加一个审批阶段（除非走自动通过）。
              </p>
            )}
          </div>

          {/* risk */}
          <div className="space-y-1.5">
            <Label className="text-xs">基础风险等级</Label>
            <Select value={riskBase} onValueChange={setRiskBase} disabled={locked}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(RISK_META).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* advanced */}
          {!locked && (
            <div className="rounded-lg border">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2.5 text-sm"
              >
                <span className="font-medium">高级匹配与规则（JSON）</span>
                <ChevronDown className={cn("h-4 w-4 transition-transform", showAdvanced && "rotate-180")} />
              </button>
              {showAdvanced && (
                <div className="space-y-3 border-t px-3 py-3">
                  <AdvancedJSON
                    label="匹配条件 selector"
                    hint='留空 = 命中该业务类型的全部请求。例：{"resource_types":["node"]}'
                    value={selectorJSON}
                    onChange={setSelectorJSON}
                  />
                  <AdvancedJSON
                    label="风险升级 promote"
                    hint='满足条件时把风险提升到更高档。例：[{"to":"critical","when":[...]}]'
                    value={riskPromoteJSON}
                    onChange={setRiskPromoteJSON}
                  />
                  <AdvancedJSON
                    label="自动通过 auto_approve"
                    hint='满足条件直接放行、免人工审批。例：{"when":[...]}'
                    value={autoApproveJSON}
                    onChange={setAutoApproveJSON}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <SheetFooter className="border-t px-5 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={save.isPending || (!locked && !name.trim())} onClick={() => save.mutate()} className="gap-1.5">
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {locked ? "保存（启用/优先级）" : editing ? "保存" : "创建"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function StageRow({
  index,
  total,
  stage,
  roles,
  locked,
  onChange,
  onRemove,
  onMove,
}: {
  index: number
  total: number
  stage: Stage
  roles: string[]
  locked: boolean
  onChange: (s: Stage) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const selectedRoles = new Set(stage.role_names ?? [])
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {index + 1}
        </span>
        <Select value={stage.mode} onValueChange={(v) => onChange({ ...stage, mode: v as ApprovalStageMode })} disabled={locked}>
          <SelectTrigger className="h-8 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STAGE_MODE_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {stage.mode === "quorum" && (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={1}
              value={stage.quorum_n ?? 1}
              onChange={(e) => onChange({ ...stage, quorum_n: Math.max(1, Number(e.target.value) || 1) })}
              disabled={locked}
              className="h-8 w-16"
            />
            <span className="text-xs text-muted-foreground">人通过</span>
          </div>
        )}
        <span className="flex-1" />
        {!locked && (
          <>
            <Button variant="ghost" size="icon" className="h-7 w-7" disabled={index === 0} onClick={() => onMove(-1)}>
              <GripVertical className="h-3.5 w-3.5 rotate-90" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" disabled={total <= 1} onClick={onRemove}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
      <p className="mt-1.5 pl-8 text-[11px] text-muted-foreground">{STAGE_MODE_HINTS[stage.mode]}</p>
      <div className="mt-2 pl-8">
        <div className="mb-1 text-[11px] text-muted-foreground">审批角色</div>
        <div className="flex flex-wrap gap-1.5">
          {roles.length === 0 && <span className="text-xs text-muted-foreground">（无可用角色）</span>}
          {roles.map((role) => {
            const on = selectedRoles.has(role)
            return (
              <button
                key={role}
                type="button"
                disabled={locked}
                onClick={() => {
                  const next = new Set(selectedRoles)
                  if (on) next.delete(role)
                  else next.add(role)
                  onChange({ ...stage, role_names: [...next] })
                }}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs transition-colors",
                  on ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent",
                  locked && "opacity-70",
                )}
              >
                {role}
              </button>
            )
          })}
        </div>
        {stage.user_ids && stage.user_ids.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">另含指定用户 {stage.user_ids.length} 名</p>
        )}
      </div>
    </div>
  )
}

function AdvancedJSON({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
}) {
  const invalid = value.trim() !== "" && (() => {
    try {
      JSON.parse(value)
      return false
    } catch {
      return true
    }
  })()
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        className={cn("font-mono text-xs", invalid && "border-destructive")}
        placeholder="留空表示不设置"
      />
      <p className={cn("text-[11px]", invalid ? "text-destructive" : "text-muted-foreground")}>
        {invalid ? "JSON 格式有误" : hint}
      </p>
    </div>
  )
}
