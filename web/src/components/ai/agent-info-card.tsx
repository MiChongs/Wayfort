"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  Activity,
  Bot,
  Hash,
  Repeat,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Thermometer,
  Wrench,
  Zap,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AgentAvatar } from "./agent-avatar"
import { toolIcon, isDangerName } from "./tool-icons"
import { cn } from "@/lib/utils"
import type { AIAgent, PermissionMode } from "@/lib/api/types"

const MODE_META: Record<PermissionMode, { icon: typeof ShieldCheck; label: string; tone: string }> = {
  plan: { icon: ShieldCheck, label: "Plan", tone: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40" },
  normal: { icon: ShieldAlert, label: "Normal", tone: "text-amber-600 dark:text-amber-400 border-amber-500/40" },
  bypass: { icon: Zap, label: "Bypass", tone: "text-sky-600 dark:text-sky-400 border-sky-500/40" },
}

function parseToolList(allowed: string | undefined): string[] {
  if (!allowed) return []
  try {
    const parsed = JSON.parse(allowed)
    if (Array.isArray(parsed)) return parsed.map((x) => String(x))
  } catch {
    /* fall through */
  }
  return allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export function AgentInfoCard({
  agent,
  model,
  variant = "full",
  className,
}: {
  agent?: AIAgent | null
  model?: string
  variant?: "full" | "compact"
  className?: string
}) {
  const reduce = useReducedMotion()
  if (!agent) {
    return (
      <Card className={cn("border-dashed", className)}>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          <Bot className="w-4 h-4 inline mr-1 align-middle" /> 未指定 Agent
        </CardContent>
      </Card>
    )
  }
  const tools = parseToolList(agent.allowed_tools)
  const dangerous: string[] = []
  const writeable: string[] = []
  const readonly: string[] = []
  for (const t of tools) {
    if (isDangerName(t)) dangerous.push(t)
    else if (t.endsWith("_readonly") || t.startsWith("list_") || t.startsWith("get_") || t.startsWith("health_") || t.startsWith("audit_") || t.startsWith("session_list"))
      readonly.push(t)
    else writeable.push(t)
  }
  const mode = MODE_META[agent.permission_mode] ?? MODE_META.normal
  const compact = variant === "compact"

  return (
    <Card
      className={cn(
        "overflow-hidden border-border/70",
        compact ? "shadow-md" : "shadow-sm",
        className,
      )}
    >
      <CardContent className={cn("p-0", compact ? "p-4" : "p-5 md:p-6")}>
        <div className="flex items-start gap-3">
          <motion.div
            initial={reduce ? false : { scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 380, damping: 30 }
            }
          >
            <AgentAvatar
              agent={agent}
              className={compact ? "w-9 h-9 text-sm" : "w-12 h-12 text-base"}
            />
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={cn("font-semibold tracking-tight", compact ? "text-sm" : "text-base")}>
                {agent.name}
              </h3>
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                {agent.scope === "global" ? "全局" : "个人"}
              </Badge>
              <Badge
                variant="outline"
                className={cn("text-[10px] h-4 px-1.5 inline-flex items-center gap-1", mode.tone)}
              >
                <mode.icon className="w-3 h-3" /> {mode.label}
              </Badge>
              {agent.is_sub_agent && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                  Sub-Agent
                </Badge>
              )}
            </div>
            {agent.description && (
              <p
                className={cn(
                  "text-muted-foreground mt-1",
                  compact ? "text-xs line-clamp-2" : "text-sm leading-relaxed",
                )}
              >
                {agent.description}
              </p>
            )}
          </div>
        </div>

        <Separator className="my-4 opacity-50" />

        <div className={cn("grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4")}>
          <MetaItem icon={Sparkles} label="模型" value={model || agent.default_model || "—"} mono />
          <MetaItem icon={Repeat} label="最大轮次" value={String(agent.max_iterations)} />
          {typeof agent.temperature === "number" && (
            <MetaItem
              icon={Thermometer}
              label="Temperature"
              value={agent.temperature.toFixed(2)}
            />
          )}
          {typeof agent.top_p === "number" && (
            <MetaItem icon={Activity} label="Top-P" value={agent.top_p.toFixed(2)} />
          )}
        </div>

        {tools.length > 0 && (
          <>
            <Separator className="my-4 opacity-50" />
            <div className="space-y-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5">
                <Wrench className="w-3 h-3" />
                可用工具 ({tools.length})
              </div>
              <div className="space-y-2">
                {readonly.length > 0 && (
                  <ToolGroup title="只读" tools={readonly} tone="emerald" />
                )}
                {writeable.length > 0 && (
                  <ToolGroup title="可写" tools={writeable} tone="sky" />
                )}
                {dangerous.length > 0 && (
                  <ToolGroup title="高危（需确认）" tools={dangerous} tone="destructive" />
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function MetaItem({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Hash
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div
        className={cn(
          "text-xs mt-0.5 truncate",
          mono ? "font-mono" : "font-medium",
        )}
      >
        {value}
      </div>
    </div>
  )
}

function ToolGroup({
  title,
  tools,
  tone,
}: {
  title: string
  tools: string[]
  tone: "emerald" | "sky" | "destructive"
}) {
  const toneCls =
    tone === "emerald"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
      : tone === "sky"
      ? "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300"
      : "border-destructive/30 bg-destructive/5 text-destructive"
  return (
    <div>
      <div className="text-[10px] text-muted-foreground mb-1.5 font-medium">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {tools.map((t) => {
          const Icon = toolIcon(t)
          return (
            <Tooltip key={t}>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-mono",
                    toneCls,
                  )}
                >
                  <Icon className="w-3 h-3" />
                  {t}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="font-mono text-[10px]">
                {t}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
