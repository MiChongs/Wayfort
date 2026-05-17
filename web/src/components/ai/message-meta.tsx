"use client"

import { ArrowDown, ArrowUp, Clock, Flag, Hash, Info } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { fullTime, relTime } from "@/lib/format"
import type { AIMessage } from "@/lib/api/types"
import { cn } from "@/lib/utils"

const FINISH_REASON_LABEL: Record<string, { label: string; tone: string }> = {
  stop: { label: "正常完成", tone: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" },
  length: { label: "长度截断", tone: "border-amber-500/40 text-amber-700 dark:text-amber-300" },
  content_filter: { label: "内容过滤", tone: "border-amber-500/40 text-amber-700 dark:text-amber-300" },
  tool_use: { label: "调用工具", tone: "border-sky-500/40 text-sky-700 dark:text-sky-300" },
  tool_calls: { label: "调用工具", tone: "border-sky-500/40 text-sky-700 dark:text-sky-300" },
  end_turn: { label: "结束本轮", tone: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" },
  max_tokens: { label: "Token 上限", tone: "border-amber-500/40 text-amber-700 dark:text-amber-300" },
  max_iterations: { label: "轮次上限", tone: "border-amber-500/40 text-amber-700 dark:text-amber-300" },
}

export function MessageMeta({ message }: { message: AIMessage }) {
  const finish = message.finish_reason
    ? FINISH_REASON_LABEL[message.finish_reason] || {
        label: message.finish_reason,
        tone: "border-border text-muted-foreground",
      }
    : null

  return (
    <div className="space-y-3 text-xs min-w-[220px]">
      <Row icon={Clock} label="时间">
        <div className="space-y-0.5">
          <div className="font-mono">{fullTime(message.created_at)}</div>
          <div className="text-[10px] text-muted-foreground">
            {relTime(message.created_at)}
          </div>
        </div>
      </Row>
      {(message.input_tokens || message.output_tokens) && (
        <Row icon={Info} label="Tokens">
          <div className="flex items-center gap-3 font-mono">
            {message.input_tokens ? (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                <ArrowUp className="w-3 h-3" />
                {message.input_tokens.toLocaleString()}
              </span>
            ) : null}
            {message.output_tokens ? (
              <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                <ArrowDown className="w-3 h-3" />
                {message.output_tokens.toLocaleString()}
              </span>
            ) : null}
          </div>
        </Row>
      )}
      {finish && (
        <Row icon={Flag} label="结束原因">
          <Badge
            variant="outline"
            className={cn("text-[10px] h-5 px-1.5", finish.tone)}
          >
            {finish.label}
          </Badge>
        </Row>
      )}
      <Row icon={Hash} label="消息 ID">
        <span className="font-mono text-[10px] text-muted-foreground">
          {message.id}
        </span>
      </Row>
    </div>
  )
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Clock
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold w-16 shrink-0 pt-0.5">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
