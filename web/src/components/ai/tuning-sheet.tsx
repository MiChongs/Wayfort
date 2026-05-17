"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Loader2, RotateCcw, Thermometer, Wand2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { aiConversationService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import type { AIAgent, AIConversation } from "@/lib/api/types"

interface TuningSheetProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  conversation: AIConversation
  agent?: AIAgent
}

export function TuningSheet({
  open,
  onOpenChange,
  conversation,
  agent,
}: TuningSheetProps) {
  const qc = useQueryClient()

  // Live local state for the controls; only commits on save.
  const [temperature, setTemperature] = React.useState<number | null>(
    conversation.temperature ?? null,
  )
  const [topP, setTopP] = React.useState<number | null>(
    conversation.top_p ?? null,
  )
  const [maxTokens, setMaxTokens] = React.useState<string>(
    conversation.max_tokens != null ? String(conversation.max_tokens) : "",
  )

  React.useEffect(() => {
    if (open) {
      setTemperature(conversation.temperature ?? null)
      setTopP(conversation.top_p ?? null)
      setMaxTokens(
        conversation.max_tokens != null ? String(conversation.max_tokens) : "",
      )
    }
  }, [open, conversation.temperature, conversation.top_p, conversation.max_tokens])

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {}
      body.temperature = temperature
      body.top_p = topP
      const mt = parseInt(maxTokens, 10)
      body.max_tokens = Number.isFinite(mt) && mt > 0 ? mt : null
      return aiConversationService.update(conversation.id, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "conv", conversation.id] })
      toast.success("调参已生效")
      onOpenChange(false)
    },
    onError: (e: unknown) =>
      toast.error("保存失败", { description: (e as Error).message }),
  })

  const reset = useMutation({
    mutationFn: () =>
      aiConversationService.update(conversation.id, { reset_overrides: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "conv", conversation.id] })
      toast.success("已重置为 Agent 默认")
      setTemperature(null)
      setTopP(null)
      setMaxTokens("")
    },
  })

  const agentTemp = agent?.temperature
  const agentTopP = agent?.top_p

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:max-w-[420px] p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-3 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Wand2 className="w-4 h-4" /> 模型调参
          </SheetTitle>
          <SheetDescription>
            本次会话的临时参数覆盖。留空 / 重置 即使用 Agent 默认值。
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          <Slider
            icon={Thermometer}
            label="Temperature"
            min={0}
            max={2}
            step={0.05}
            value={temperature}
            agentDefault={agentTemp}
            onChange={setTemperature}
            help="决定生成随机性。0 = 最确定，2 = 最发散。"
          />
          <Slider
            icon={Wand2}
            label="Top-P"
            min={0}
            max={1}
            step={0.05}
            value={topP}
            agentDefault={agentTopP}
            onChange={setTopP}
            help="核采样阈值。1.0 = 不限制。"
          />
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <label className="font-medium">Max Tokens（单轮输出上限）</label>
              <span className="text-muted-foreground font-mono">
                {maxTokens ? maxTokens : "默认"}
              </span>
            </div>
            <Input
              type="number"
              min={64}
              max={32000}
              step={64}
              placeholder="留空 = 由 provider 决定（通常 4096）"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              想出长报告就开大；想节省 token 就缩小。
            </p>
          </div>
        </div>

        <Separator />
        <div className="p-4 flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
          >
            {reset.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5" />
            )}
            重置为 Agent 默认
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              保存
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Slider({
  icon: Icon,
  label,
  min,
  max,
  step,
  value,
  agentDefault,
  onChange,
  help,
}: {
  icon: typeof Thermometer
  label: string
  min: number
  max: number
  step: number
  value: number | null
  agentDefault?: number
  onChange: (v: number | null) => void
  help?: string
}) {
  const active = value !== null
  const display = active ? value : (agentDefault ?? min)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <label className="inline-flex items-center gap-1.5 font-medium">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </label>
        <div className="inline-flex items-center gap-2 font-mono">
          {!active && (
            <span className="text-[10px] text-muted-foreground/70">
              Agent: {agentDefault != null ? agentDefault.toFixed(2) : "—"}
            </span>
          )}
          <span className={cn(active ? "text-foreground" : "text-muted-foreground")}>
            {display != null ? Number(display).toFixed(2) : "—"}
          </span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={display ?? min}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          "w-full h-1.5 bg-muted rounded-full appearance-none cursor-pointer",
          "accent-primary",
        )}
      />
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground leading-relaxed">{help}</p>
        {active && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[10px] text-muted-foreground/70 hover:text-foreground underline-offset-4 hover:underline"
          >
            清除覆盖
          </button>
        )}
      </div>
    </div>
  )
}
