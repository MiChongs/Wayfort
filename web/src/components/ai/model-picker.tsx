"use client"

import * as React from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { Check, ChevronDown, Cpu, Eye, Loader2, Wrench } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { aiProviderService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import type { AIProvider } from "@/lib/api/types"

interface ModelPickerProps {
  currentProviderID?: number
  currentModel?: string
  onPick: (providerID: number, model: string) => void
  disabled?: boolean
}

export function ModelPicker({
  currentProviderID,
  currentModel,
  onPick,
  disabled,
}: ModelPickerProps) {
  const [open, setOpen] = React.useState(false)
  const providers = useQuery({
    queryKey: ["ai", "providers"],
    queryFn: aiProviderService.list,
  })
  const enabled = (providers.data?.providers || []).filter(
    (p) => p.enabled !== false,
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                "inline-flex items-center gap-1 font-mono text-xs px-1.5 py-0.5 rounded",
                "border border-transparent",
                "hover:border-border hover:bg-muted/50 transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                disabled && "opacity-60 cursor-not-allowed",
              )}
            >
              <Cpu className="w-3 h-3 opacity-70" />
              <span>{currentModel || "—"}</span>
              <ChevronDown className="w-3 h-3 opacity-60" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">点击切换模型</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={8}
        className="w-[420px] max-w-[calc(100vw-2rem)] p-0 max-h-[60vh] overflow-y-auto"
      >
        {providers.isLoading ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="inline w-3.5 h-3.5 mr-1 animate-spin" /> 加载中…
          </div>
        ) : enabled.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            没有启用的提供商
          </div>
        ) : (
          <ProviderGroups
            providers={enabled}
            currentProviderID={currentProviderID}
            currentModel={currentModel}
            onPick={(pid, model) => {
              onPick(pid, model)
              setOpen(false)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function ProviderGroups({
  providers,
  currentProviderID,
  currentModel,
  onPick,
}: {
  providers: AIProvider[]
  currentProviderID?: number
  currentModel?: string
  onPick: (providerID: number, model: string) => void
}) {
  const modelQueries = useQueries({
    queries: providers.map((p) => ({
      queryKey: ["ai", "providers", p.id, "models"],
      queryFn: () => aiProviderService.models(p.id),
      staleTime: 60_000,
    })),
  })

  return (
    <div className="py-1">
      {providers.map((p, i) => {
        const q = modelQueries[i]
        const models = q.data?.models || []
        return (
          <div key={p.id} className="px-1 pb-1">
            <div className="flex items-center gap-2 px-2 py-1.5 sticky top-0 bg-popover/95 backdrop-blur z-10">
              <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                {p.display_name || p.name}
              </span>
              <Badge variant="outline" className="h-4 text-[9px] px-1">
                {p.kind}
              </Badge>
              {p.default_model && (
                <span className="text-[10px] text-muted-foreground/70 truncate">
                  默认 <code className="font-mono">{p.default_model}</code>
                </span>
              )}
            </div>
            {q.isLoading ? (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                <Loader2 className="inline w-3 h-3 mr-1 animate-spin" /> 拉模型…
              </div>
            ) : models.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                没有可用模型
              </div>
            ) : (
              <ul>
                {models.map((m) => {
                  const isCurrent =
                    p.id === currentProviderID && m.id === currentModel
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => onPick(p.id, m.id)}
                        className={cn(
                          "w-full text-left flex items-center gap-2 px-2 py-1.5 rounded",
                          "hover:bg-accent/60 focus:outline-none focus-visible:bg-accent/60",
                          isCurrent && "bg-accent/40",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-flex w-3.5 h-3.5 shrink-0 items-center justify-center",
                            isCurrent ? "text-primary" : "opacity-0",
                          )}
                        >
                          <Check className="w-3.5 h-3.5" />
                        </span>
                        <code className="font-mono text-xs truncate flex-1">
                          {m.label || m.id}
                        </code>
                        {m.context_window ? (
                          <Badge
                            variant="outline"
                            className="h-4 text-[9px] px-1"
                            title="Context window"
                          >
                            {formatTokens(m.context_window)}
                          </Badge>
                        ) : null}
                        {m.tools ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-emerald-600 dark:text-emerald-400">
                                <Wrench className="w-3 h-3" />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="left">支持工具调用</TooltipContent>
                          </Tooltip>
                        ) : null}
                        {m.vision ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-sky-600 dark:text-sky-400">
                                <Eye className="w-3 h-3" />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="left">支持图像</TooltipContent>
                          </Tooltip>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}
