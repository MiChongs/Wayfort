"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { AlertCircle, Loader2, MonitorPlay, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { phaseLabel, type GuacPhase } from "./guac-errors"

export interface GuacLoaderProps {
  phase: GuacPhase
  elapsedMs: number
  errorTitle?: string
  errorHint?: string
  errorCode?: number
  nodeName?: string
  onRetry(): void
}

const STAGES: GuacPhase[] = ["loading-script", "connecting", "handshake", "connected"]

export function GuacLoader({
  phase,
  elapsedMs,
  errorTitle,
  errorHint,
  errorCode,
  nodeName,
  onRetry,
}: GuacLoaderProps) {
  const reduce = useReducedMotion()
  const isError = phase === "error"
  const currentIdx = STAGES.indexOf(phase)

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/95 backdrop-blur-sm">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 28 }}
        className="w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-border/40 bg-card/60 backdrop-blur p-6 shadow-2xl text-card-foreground"
      >
        <div className="flex items-center gap-3">
          <motion.div
            className={cn(
              "w-12 h-12 rounded-xl flex items-center justify-center border",
              isError
                ? "bg-destructive/10 border-destructive/30 text-destructive"
                : "bg-primary/10 border-primary/30 text-primary",
            )}
            animate={
              reduce || isError
                ? undefined
                : {
                    scale: [1, 1.08, 1],
                    boxShadow: [
                      "0 0 0 0 rgba(99, 102, 241, 0)",
                      "0 0 0 8px rgba(99, 102, 241, 0.12)",
                      "0 0 0 0 rgba(99, 102, 241, 0)",
                    ],
                  }
            }
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          >
            {isError ? (
              <AlertCircle className="w-6 h-6" />
            ) : (
              <MonitorPlay className="w-6 h-6" />
            )}
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate">
              {isError
                ? errorTitle || "连接失败"
                : `正在连接 ${nodeName || "远程桌面"}`}
            </div>
            <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
              {isError ? (
                errorCode != null ? (
                  <>错误码 0x{errorCode.toString(16).toUpperCase().padStart(4, "0")}</>
                ) : (
                  "—"
                )
              ) : (
                <>已用时 {(elapsedMs / 1000).toFixed(1)}s</>
              )}
            </div>
          </div>
        </div>

        {!isError && (
          <ul className="mt-4 space-y-1.5">
            {STAGES.map((s, i) => {
              const done = i < currentIdx || phase === "connected"
              const active = i === currentIdx && phase !== "connected"
              return (
                <li
                  key={s}
                  className={cn(
                    "flex items-center gap-2 text-xs",
                    done && "text-emerald-600 dark:text-emerald-400",
                    active && "text-foreground",
                    !done && !active && "text-muted-foreground/60",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex w-4 h-4 rounded-full border items-center justify-center text-[10px] shrink-0",
                      done && "border-emerald-500/60 bg-emerald-500/15",
                      active && "border-primary/60 bg-primary/10",
                      !done && !active && "border-border/60",
                    )}
                  >
                    {done ? "✓" : active ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    ) : (
                      ""
                    )}
                  </span>
                  <span>{phaseLabel(s)}</span>
                </li>
              )
            })}
          </ul>
        )}

        {isError && (
          <>
            {errorHint && (
              <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
                {errorHint}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" onClick={onRetry}>
                <RefreshCw className="w-3.5 h-3.5" /> 重试
              </Button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  )
}
