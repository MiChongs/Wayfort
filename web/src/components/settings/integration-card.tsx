"use client"

import * as React from "react"
import { motion } from "motion/react"
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, PlugZap, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { IntegrationState, IntegrationStatus } from "@/lib/api/types"
import { Button } from "@/components/ui/button"

const STATE: Record<
  IntegrationState,
  { label: string; dot: string; text: string; ring: string; icon: React.ComponentType<{ className?: string }> }
> = {
  disabled: { label: "未启用", dot: "bg-muted-foreground/40", text: "text-muted-foreground", ring: "ring-border", icon: CircleSlash },
  unconfigured: { label: "待配置", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-300", ring: "ring-amber-500/30", icon: Settings2 },
  configured: { label: "未测试", dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-300", ring: "ring-sky-500/30", icon: PlugZap },
  healthy: { label: "连接正常", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300", ring: "ring-emerald-500/30", icon: CheckCircle2 },
  error: { label: "连接异常", dot: "bg-destructive", text: "text-destructive", ring: "ring-destructive/30", icon: AlertTriangle },
}

function relTime(iso?: string) {
  if (!iso) return ""
  const d = new Date(iso).getTime()
  const s = Math.floor((Date.now() - d) / 1000)
  if (s < 60) return "刚刚"
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

export function IntegrationCard({
  integration,
  testing,
  onTest,
}: {
  integration: IntegrationStatus
  testing: boolean
  onTest: () => void
}) {
  const meta = STATE[integration.state] ?? STATE.disabled
  const Icon = meta.icon
  const canTest = integration.state !== "disabled" && integration.state !== "unconfigured"

  return (
    <div className="rounded-xl border border-border bg-card p-4 transition-shadow hover:shadow-[0_1px_3px_rgba(20,20,19,0.06)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary/70", meta.text)}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{integration.title}</div>
            {integration.summary && (
              <div className="truncate text-xs text-muted-foreground" title={integration.summary}>
                {integration.summary}
              </div>
            )}
          </div>
        </div>
        <motion.span
          key={integration.state}
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset",
            meta.text,
            meta.ring,
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
          {meta.label}
        </motion.span>
      </div>

      {integration.state === "error" && integration.detail && (
        <p className="mt-2.5 rounded-md bg-destructive/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-destructive">
          {integration.detail}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {integration.tested_at
            ? `${integration.latency_ms ?? 0}ms · ${relTime(integration.tested_at)}`
            : canTest
              ? "尚未测试"
              : ""}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={!canTest || testing}
          onClick={onTest}
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
          测试连接
        </Button>
      </div>
    </div>
  )
}
