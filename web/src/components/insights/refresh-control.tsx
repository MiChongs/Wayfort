"use client"

import * as React from "react"
import { motion } from "motion/react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { relativeTime } from "./format"

export type RefreshInterval = 0 | 1000 | 2000 | 5000 | 10000 | 30000 | 60000

const OPTIONS: { value: RefreshInterval; label: string; warn?: boolean }[] = [
  { value: 0, label: "关闭" },
  { value: 1000, label: "1 秒", warn: true },
  { value: 2000, label: "2 秒", warn: true },
  { value: 5000, label: "5 秒" },
  { value: 10000, label: "10 秒" },
  { value: 30000, label: "30 秒" },
  { value: 60000, label: "60 秒" },
]

const INTERVAL_KEY = "insights:refreshInterval"

export function loadDefaultInterval(): RefreshInterval {
  if (typeof window === "undefined") return 5000
  const v = Number(window.localStorage.getItem(INTERVAL_KEY))
  const found = OPTIONS.find((o) => o.value === v)
  return found ? (v as RefreshInterval) : 5000
}

export function saveDefaultInterval(v: RefreshInterval) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(INTERVAL_KEY, String(v))
}

export interface RefreshControlProps {
  interval: RefreshInterval
  onChange(v: RefreshInterval): void
  onManualRefresh(): void
  refreshing?: boolean
  lastUpdated?: string // ISO string
  className?: string
}

export function RefreshControl({
  interval,
  onChange,
  onManualRefresh,
  refreshing,
  lastUpdated,
  className,
}: RefreshControlProps) {
  const opt = OPTIONS.find((o) => o.value === interval) ?? OPTIONS[3]
  const [tick, setTick] = React.useState(0)
  // Re-render every 5s so "X 秒前" stays accurate even when polling is off.
  React.useEffect(() => {
    const t = window.setInterval(() => setTick((v) => v + 1), 5000)
    return () => window.clearInterval(t)
  }, [])
  // Reference the tick so linters don't strip the effect.
  void tick

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {lastUpdated && (
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {relativeTime(lastUpdated) || "刚刚"}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onManualRefresh}
            aria-label="立刻刷新"
          >
            <RefreshCw
              className={cn("w-3.5 h-3.5", refreshing && "animate-spin")}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">立刻刷新</TooltipContent>
      </Tooltip>
      <Select
        value={String(interval)}
        onValueChange={(v) => onChange(Number(v) as RefreshInterval)}
      >
        <SelectTrigger className="h-7 px-2 gap-1 text-[11px] w-auto min-w-0 border-border/60">
          <SelectValue placeholder="刷新间隔" />
          {opt.warn && interval !== 0 && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-amber-500"
            >
              <AlertTriangle className="w-3 h-3" />
            </motion.span>
          )}
        </SelectTrigger>
        <SelectContent>
          {OPTIONS.map((o) => (
            <SelectItem key={o.value} value={String(o.value)} className="text-xs">
              {o.label}
              {o.warn && <span className="ml-1 text-amber-500">⚠</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
