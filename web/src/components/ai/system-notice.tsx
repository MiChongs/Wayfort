"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { AlertCircle, AlertTriangle, Info, RefreshCw } from "lucide-react"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export type NoticeLevel = "info" | "warning" | "error"

const ICONS: Record<NoticeLevel, typeof AlertCircle> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
}

const VARIANT_BY_LEVEL: Record<NoticeLevel, "info" | "warning" | "destructive"> = {
  info: "info",
  warning: "warning",
  error: "destructive",
}

export const SystemNotice = React.memo(function SystemNotice({
  level,
  title,
  description,
  retryable,
  onRetry,
}: {
  level: NoticeLevel
  title: string
  description?: string
  retryable?: boolean
  onRetry?: () => void
}) {
  const reduce = useReducedMotion()
  const Icon = ICONS[level]
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <motion.div
        className="flex-1 max-w-3xl"
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.22, ease: "easeOut" }}
      >
        <Alert variant={VARIANT_BY_LEVEL[level]}>
          <Icon className="w-4 h-4" />
          <div>
            <AlertTitle>{title}</AlertTitle>
            {description && (
              <AlertDescription className="break-words">{description}</AlertDescription>
            )}
            {retryable && onRetry && (
              <div className="mt-2">
                <motion.div whileTap={reduce ? undefined : { scale: 0.96 }} className="inline-block">
                  <Button size="sm" variant="outline" onClick={onRetry}>
                    <RefreshCw className="w-3.5 h-3.5" /> 重新发送
                  </Button>
                </motion.div>
              </div>
            )}
          </div>
        </Alert>
      </motion.div>
    </div>
  )
})
