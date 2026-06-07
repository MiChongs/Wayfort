"use client"

import * as React from "react"
import { Plus, RotateCcw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SettingField } from "@/lib/api/types"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// Wide controls stack their control below the label; compact ones sit on the
// right of the label row.
function isWide(t: SettingField["type"]) {
  return t === "stringlist" || t === "stringmap" || t === "text"
}

export interface SettingFieldRowProps {
  field: SettingField
  /** Current edited value (draft if dirty, else the server value). */
  value: unknown
  /** Whether this field currently has an unsaved change. */
  dirty: boolean
  /** Dependency gate — when false the row is dimmed + non-interactive. */
  active: boolean
  onChange: (v: unknown) => void
  /** Reset this key to its built-in default (only shown when overridden). */
  onReset?: () => void
}

export function SettingFieldRow({ field, value, dirty, active, onChange, onReset }: SettingFieldRowProps) {
  const wide = isWide(field.type)
  const label = (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-[13.5px] font-medium text-foreground">{field.label}</Label>
        {!field.live && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="h-5 cursor-default gap-1 border-amber-500/40 px-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-300">
                重启生效
              </Badge>
            </TooltipTrigger>
            <TooltipContent>保存后需重启网关进程方可应用</TooltipContent>
          </Tooltip>
        )}
        {field.overridden && !dirty && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="已自定义" />
            </TooltipTrigger>
            <TooltipContent>已自定义（覆盖了默认值）</TooltipContent>
          </Tooltip>
        )}
        {dirty && (
          <Badge variant="coral" className="h-5 px-1.5 text-[10px] font-normal">未保存</Badge>
        )}
        {field.overridden && onReset && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onReset}
                className="text-muted-foreground/70 transition-colors hover:text-foreground"
                aria-label="重置为默认"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>重置为默认值</TooltipContent>
          </Tooltip>
        )}
      </div>
      {field.help && (
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{field.help}</p>
      )}
    </div>
  )

  const control = (
    <FieldControl field={field} value={value} active={active} onChange={onChange} />
  )

  return (
    <div
      className={cn(
        "border-b border-border/60 py-4 transition-opacity last:border-b-0",
        !active && "pointer-events-none opacity-45",
      )}
    >
      {wide ? (
        <div className="space-y-3">
          {label}
          <div>{control}</div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-6">
          {label}
          <div className="flex shrink-0 items-center justify-end pt-0.5">{control}</div>
        </div>
      )}
    </div>
  )
}

function FieldControl({
  field,
  value,
  active,
  onChange,
}: {
  field: SettingField
  value: unknown
  active: boolean
  onChange: (v: unknown) => void
}) {
  switch (field.type) {
    case "bool":
      return <Switch checked={Boolean(value)} disabled={!active} onCheckedChange={onChange} />
    case "enum":
      return <EnumControl field={field} value={String(value ?? "")} disabled={!active} onChange={onChange} />
    case "int":
    case "float":
      return <NumberControl field={field} value={Number(value ?? 0)} disabled={!active} onChange={onChange} />
    case "duration":
      return <DurationControl value={String(value ?? "0s")} disabled={!active} onChange={onChange} />
    case "secret":
      return <SecretControl field={field} value={typeof value === "string" ? value : ""} disabled={!active} onChange={onChange} />
    case "stringlist":
      return <ListControl field={field} value={Array.isArray(value) ? (value as string[]) : []} disabled={!active} onChange={onChange} />
    case "stringmap":
      return <MapControl value={(value && typeof value === "object" ? (value as Record<string, string>) : {})} disabled={!active} onChange={onChange} />
    case "text":
      return (
        <Textarea
          value={String(value ?? "")}
          disabled={!active}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-24 font-mono text-xs"
        />
      )
    case "string":
    default:
      return (
        <Input
          value={String(value ?? "")}
          disabled={!active}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-[260px]"
        />
      )
  }
}

function EnumControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SettingField
  value: string
  disabled: boolean
  onChange: (v: string) => void
}) {
  const opts = field.enum ?? []
  // Segmented control for small option sets — quicker to scan and nicer than a
  // dropdown; fall back to a Select once there are too many to fit on a row.
  if (opts.length > 0 && opts.length <= 3 && opts.every((o) => o.label.length <= 6)) {
    return (
      <div className="inline-flex rounded-lg border border-border bg-secondary/50 p-0.5">
        {opts.map((o) => {
          const on = o.value === value
          const btn = (
            <button
              key={o.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                on
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          )
          return o.help ? (
            <Tooltip key={o.value}>
              <TooltipTrigger asChild>{btn}</TooltipTrigger>
              <TooltipContent>{o.help}</TooltipContent>
            </Tooltip>
          ) : (
            btn
          )
        })}
      </div>
    )
  }
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger className="w-[220px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {opts.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="flex flex-col">
              <span>{o.label}</span>
              {o.help && <span className="text-xs text-muted-foreground">{o.help}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function NumberControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SettingField
  value: number
  disabled: boolean
  onChange: (v: number) => void
}) {
  const hasRange = field.min != null && field.max != null
  const useSlider = hasRange && (field.max as number) <= 100
  if (useSlider) {
    const step = field.step ?? (field.type === "float" ? 0.1 : 1)
    return (
      <div className="flex w-[260px] items-center gap-3">
        <Slider
          value={[value]}
          min={field.min}
          max={field.max}
          step={step}
          disabled={disabled}
          onValueChange={(v) => onChange(v[0])}
          className="flex-1"
        />
        <div className="flex min-w-14 items-baseline justify-end gap-1 tabular-nums">
          <span className="text-sm font-medium text-foreground">{value}</span>
          {field.unit && <span className="text-xs text-muted-foreground">{field.unit}</span>}
        </div>
      </div>
    )
  }
  return (
    <div className="relative w-[200px]">
      <Input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={field.min}
        max={field.max}
        step={field.step ?? (field.type === "float" ? 0.1 : 1)}
        disabled={disabled}
        onChange={(e) => onChange(field.type === "float" ? parseFloat(e.target.value) : parseInt(e.target.value, 10) || 0)}
        className={cn(field.unit && "pr-12")}
      />
      {field.unit && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          {field.unit}
        </span>
      )}
    </div>
  )
}

const DUR_UNITS = [
  { suffix: "ms", label: "毫秒", ms: 1 },
  { suffix: "s", label: "秒", ms: 1000 },
  { suffix: "m", label: "分钟", ms: 60_000 },
  { suffix: "h", label: "小时", ms: 3_600_000 },
] as const

function parseGoDuration(s: string): number {
  let total = 0
  const re = /([0-9.]+)(ns|us|µs|ms|s|m|h)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const n = parseFloat(m[1])
    switch (m[2]) {
      case "ns": total += n / 1e6; break
      case "us":
      case "µs": total += n / 1e3; break
      case "ms": total += n; break
      case "s": total += n * 1000; break
      case "m": total += n * 60_000; break
      case "h": total += n * 3_600_000; break
    }
  }
  return total
}

function DurationControl({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (v: string) => void
}) {
  // Derive the displayed {num, unit} from the canonical Go-duration string.
  const ms = parseGoDuration(value)
  const initial = React.useMemo(() => {
    if (ms === 0) return { num: 0, unit: "s" }
    for (let i = DUR_UNITS.length - 1; i >= 0; i--) {
      if (ms % DUR_UNITS[i].ms === 0) return { num: ms / DUR_UNITS[i].ms, unit: DUR_UNITS[i].suffix }
    }
    return { num: ms, unit: "ms" }
  }, [ms])

  const [num, setNum] = React.useState(initial.num)
  const [unit, setUnit] = React.useState<string>(initial.unit)
  React.useEffect(() => {
    setNum(initial.num)
    setUnit(initial.unit)
  }, [initial.num, initial.unit])

  const emit = (n: number, u: string) => onChange(`${n}${u}`)

  return (
    <div className="flex w-[260px] items-center gap-2">
      <Input
        type="number"
        min={0}
        value={num}
        disabled={disabled}
        onChange={(e) => {
          const n = parseFloat(e.target.value)
          const v = Number.isFinite(n) ? n : 0
          setNum(v)
          emit(v, unit)
        }}
        className="flex-1"
      />
      <Select
        value={unit}
        disabled={disabled}
        onValueChange={(u) => {
          setUnit(u)
          emit(num, u)
        }}
      >
        <SelectTrigger className="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DUR_UNITS.map((u) => (
            <SelectItem key={u.suffix} value={u.suffix}>
              {u.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function SecretControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SettingField
  value: string
  disabled: boolean
  onChange: (v: string) => void
}) {
  const configured = field.secret_set
  return (
    <div className="flex w-[260px] flex-col items-end gap-1">
      <Input
        type="password"
        value={value}
        disabled={disabled}
        placeholder={configured ? "已配置 · 留空保持不变" : (field.placeholder ?? "未配置")}
        autoComplete="new-password"
        onChange={(e) => onChange(e.target.value)}
        className="w-full"
      />
      {configured && (
        <span className="text-[11px] text-muted-foreground">已加密存储</span>
      )}
    </div>
  )
}

function ListControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SettingField
  value: string[]
  disabled: boolean
  onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = React.useState("")
  const add = () => {
    const v = draft.trim()
    if (!v || value.includes(v)) {
      setDraft("")
      return
    }
    onChange([...value, v])
    setDraft("")
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 && <span className="text-xs text-muted-foreground">（空 · 使用内置默认）</span>}
        {value.map((item) => (
          <Badge key={item} variant="soft" className="gap-1 pr-1 font-mono text-[11px] font-normal">
            {item}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(value.filter((x) => x !== item))}
              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label={`移除 ${item}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          disabled={disabled}
          placeholder={field.placeholder ?? "输入后回车添加"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          className="max-w-xs font-mono text-xs"
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || !draft.trim()} onClick={add}>
          <Plus className="h-3.5 w-3.5" /> 添加
        </Button>
      </div>
    </div>
  )
}

function MapControl({
  value,
  disabled,
  onChange,
}: {
  value: Record<string, string>
  disabled: boolean
  onChange: (v: Record<string, string>) => void
}) {
  const entries = Object.entries(value)
  const [k, setK] = React.useState("")
  const [v, setV] = React.useState("")
  const setEntry = (key: string, val: string) => onChange({ ...value, [key]: val })
  const removeEntry = (key: string) => {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }
  const add = () => {
    const kk = k.trim()
    if (!kk) return
    setEntry(kk, v.trim())
    setK("")
    setV("")
  }
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {entries.length === 0 && <span className="text-xs text-muted-foreground">（无条目）</span>}
        {entries.map(([key, val]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate font-mono text-xs text-muted-foreground">{key}</span>
            <Input
              value={val}
              disabled={disabled}
              onChange={(e) => setEntry(key, e.target.value)}
              className="max-w-xs font-mono text-xs"
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => removeEntry(key)}
              className="text-muted-foreground transition-colors hover:text-destructive"
              aria-label={`移除 ${key}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input value={k} disabled={disabled} placeholder="键" onChange={(e) => setK(e.target.value)} className="w-28 font-mono text-xs" />
        <Input value={v} disabled={disabled} placeholder="值" onChange={(e) => setV(e.target.value)} className="max-w-xs font-mono text-xs" />
        <Button type="button" variant="outline" size="sm" disabled={disabled || !k.trim()} onClick={add}>
          <Plus className="h-3.5 w-3.5" /> 添加
        </Button>
      </div>
    </div>
  )
}
