"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import type { FailoverStrategy, Proxy, ProxyFailoverGroup } from "@/lib/api/types"
import { KIND_LABEL } from "./proxy-kind"
import { HealthDot } from "./proxy-health/health-dot"
import { useProxyHealthCtx } from "./proxy-health/health-context"

const STRATEGIES: { value: FailoverStrategy; label: string; hint: string }[] = [
  { value: "ordered", label: "顺序", hint: "按优先级依次尝试，第一个可用即用" },
  { value: "health_weighted", label: "健康加权", hint: "优先在线、低延迟的成员" },
  { value: "round_robin", label: "轮询", hint: "每次拨号轮换起始成员，分摊负载" },
]

/**
 * FailoverGroupEditor — compose a failover hop: an ordered member list (each with
 * a live HealthDot + up/down/remove), a strategy selector and retry/backoff
 * knobs. Members are existing non-group proxies. Emits a ProxyFailoverGroup.
 */
export function FailoverGroupEditor({
  value,
  onChange,
  proxies,
  selfId,
}: {
  value: ProxyFailoverGroup
  onChange: (g: ProxyFailoverGroup) => void
  proxies: Proxy[]
  selfId?: number
}) {
  const health = useProxyHealthCtx()
  const [pickOpen, setPickOpen] = React.useState(false)
  const byId = React.useMemo(() => new Map(proxies.map((p) => [p.id, p])), [proxies])

  const patch = (g: Partial<ProxyFailoverGroup>) => onChange({ ...value, ...g })
  const setMembers = (members: number[]) => patch({ members })

  const available = proxies.filter(
    (p) => p.kind !== "failover" && p.id !== selfId && !value.members.includes(p.id),
  )

  const move = (i: number, j: number) => {
    if (j < 0 || j >= value.members.length) return
    const next = value.members.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setMembers(next)
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-accent/40 p-3">
      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">成员（按优先级排序）</div>
        {value.members.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-background px-3 py-3 text-center text-xs text-muted-foreground">
            至少添加一个成员代理
          </p>
        ) : (
          <ol className="space-y-1.5">
            {value.members.map((mid, i) => {
              const m = byId.get(mid)
              const hp = health.byId(mid)
              return (
                <li
                  key={mid}
                  className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5"
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                    {i + 1}
                  </span>
                  <HealthDot state={hp?.state ?? "unknown"} pulse={false} />
                  <span className="min-w-0 flex-1 truncate text-sm">{m ? m.name : `#${mid}`}</span>
                  {m && <span className="text-[10px] text-muted-foreground">{KIND_LABEL[m.kind]}</span>}
                  <div className="flex items-center gap-0.5">
                    <Button type="button" size="icon" variant="ghost" className="h-6 w-6" disabled={i === 0} onClick={() => move(i, i - 1)}>
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" className="h-6 w-6" disabled={i === value.members.length - 1} onClick={() => move(i, i + 1)}>
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => setMembers(value.members.filter((x) => x !== mid))}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        <Popover open={pickOpen} onOpenChange={setPickOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="outline" className="h-8" disabled={available.length === 0}>
              <Plus className="h-3.5 w-3.5" /> 添加成员
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder="搜索代理…" />
              <CommandList>
                <CommandEmpty>没有可添加的代理</CommandEmpty>
                <CommandGroup>
                  {available.map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`${p.name} ${p.host}`}
                      onSelect={() => {
                        setMembers([...value.members, p.id])
                        setPickOpen(false)
                      }}
                    >
                      <HealthDot state={health.byId(p.id)?.state ?? "unknown"} pulse={false} className="mr-2" />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="ml-2 text-[10px] text-muted-foreground">{KIND_LABEL[p.kind]}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">策略</div>
          <Select value={value.strategy} onValueChange={(v) => patch({ strategy: v as FailoverStrategy })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  <span className="flex flex-col">
                    <span>{s.label}</span>
                    <span className="text-[10px] text-muted-foreground">{s.hint}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">重试次数</div>
          <Input
            type="number"
            min={0}
            value={value.retry}
            onChange={(e) => patch({ retry: Math.max(0, Number(e.target.value)) })}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">退避基数 (ms)</div>
          <Input
            type="number"
            min={0}
            step={100}
            value={value.backoff_ms}
            onChange={(e) => patch({ backoff_ms: Math.max(0, Number(e.target.value)) })}
            className="h-9"
          />
        </div>
      </div>
    </div>
  )
}
