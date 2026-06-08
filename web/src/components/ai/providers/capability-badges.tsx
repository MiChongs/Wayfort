"use client"

import { Brain, Database, Eye, Wrench } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AIModel } from "@/lib/api/types"

// CapabilityBadges renders the tools/vision/reasoning/caching cluster for a model
// as compact colored icon chips (mirrors model-picker's Wrench/Eye grammar).
// Inactive caps are dimmed rather than hidden, so the row stays a fixed width.
const CAPS: { key: keyof Pick<AIModel, "tools" | "vision" | "reasoning" | "caching">; icon: typeof Wrench; label: string; color: string }[] = [
  { key: "tools", icon: Wrench, label: "工具调用", color: "text-primary" },
  { key: "vision", icon: Eye, label: "视觉输入", color: "text-accent-teal" },
  { key: "reasoning", icon: Brain, label: "扩展思考", color: "text-warning" },
  { key: "caching", icon: Database, label: "提示缓存", color: "text-success" },
]

export function CapabilityBadges({ model, className }: { model: AIModel; className?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      {CAPS.map(({ key, icon: Icon, label, color }) => {
        const on = !!model[key]
        return (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "inline-flex size-5 items-center justify-center rounded-md border",
                  on ? cn("bg-card", color) : "border-transparent text-muted-foreground/30",
                )}
              >
                <Icon className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{label}{on ? "" : "（不支持）"}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
