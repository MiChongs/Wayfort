"use client"

import { motion, useReducedMotion } from "motion/react"
import { Clock, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { ToolOutputView } from "./tool-output"
import { toolIcon, isDangerName } from "./tool-icons"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AIToolInvocation } from "@/lib/api/types"

const STATUS_COLOR: Record<AIToolInvocation["status"], string> = {
  pending: "bg-amber-500",
  approved: "bg-sky-500",
  rejected: "bg-zinc-400",
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
  dry_run: "bg-zinc-400",
}

export function InvocationTimeline({ invocations }: { invocations: AIToolInvocation[] }) {
  const reduce = useReducedMotion()

  if (invocations.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        本会话还没有任何工具调用
      </div>
    )
  }

  return (
    <div className="px-4 md:px-6 py-6 max-w-4xl mx-auto">
      <div className="relative">
        <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" />
        <div className="space-y-4">
          {invocations
            .slice()
            .reverse()
            .map((inv, i) => {
              const Icon = toolIcon(inv.tool_name)
              return (
                <motion.div
                  key={inv.id}
                  initial={reduce ? false : { opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : { duration: 0.3, delay: Math.min(i * 0.04, 0.32), ease: "easeOut" }
                  }
                  className="relative pl-10"
                >
                  <span
                    className={cn(
                      "absolute left-2 top-3 w-[14px] h-[14px] rounded-full border-2 border-background shadow",
                      STATUS_COLOR[inv.status],
                    )}
                  />
                  <Card className="overflow-hidden">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium flex-wrap">
                            <Icon className="w-4 h-4 text-foreground/80" />
                            <code className="font-mono">{inv.tool_name}</code>
                            {isDangerName(inv.tool_name) && (
                              <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
                                高危
                              </Badge>
                            )}
                            <Badge variant="outline" className="text-[10px] h-5">
                              {inv.status}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px] h-5">
                              {inv.permission_mode}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="w-3 h-3" /> {fullTime(inv.created_at)}
                            </span>
                            <span>· {relTime(inv.created_at)}</span>
                            {typeof inv.duration_ms === "number" && inv.duration_ms > 0 && (
                              <span>· {inv.duration_ms} ms</span>
                            )}
                            {inv.output_truncated && <span>· 输出已截断</span>}
                          </div>
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground shrink-0">
                          {inv.id.slice(0, 8)}
                        </div>
                      </div>

                      <div className="mt-3 space-y-2">
                        <details className="text-xs group">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground flex items-center gap-1 list-none">
                            <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                            输入参数
                          </summary>
                          <pre className="mt-1 bg-zinc-950 text-zinc-100 p-2 rounded overflow-auto text-[11px] leading-relaxed">
                            {prettyJson(inv.input)}
                          </pre>
                        </details>
                        {inv.output && (
                          <details className="text-xs group" open>
                            <summary className="cursor-pointer text-muted-foreground hover:text-foreground flex items-center gap-1 list-none">
                              <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                              输出 ({fmtBytes(inv.output.length)})
                            </summary>
                            <div className="mt-1">
                              <ToolOutputView raw={inv.output} />
                            </div>
                          </details>
                        )}
                        {inv.error && (
                          <div className="text-xs text-destructive bg-destructive/10 rounded px-2 py-1.5 font-mono">
                            错误：{inv.error}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              )
            })}
        </div>
      </div>
    </div>
  )
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}
