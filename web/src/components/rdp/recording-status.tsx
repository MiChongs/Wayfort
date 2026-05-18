"use client"

// RecordingStatus — Plan 15. Floating timer badge in the bottom-right
// corner whenever a recording is active. Shows elapsed time + approximate
// captured bytes. Click to stop.

import * as React from "react"
import { motion, AnimatePresence } from "motion/react"
import { CircleStop } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { RecordingEvent } from "@/lib/rdp/plugins/recording"

export interface RecordingStatusProps {
  event: RecordingEvent
  onStop(): void
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export function RecordingStatus({ event, onStop }: RecordingStatusProps) {
  const visible = event.state === "recording" || event.state === "stopping"
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 16, opacity: 0 }}
          className="absolute bottom-4 left-4 z-30 flex items-center gap-2 px-2.5 py-1.5 bg-background/90 backdrop-blur border border-destructive/40 rounded-full shadow-lg"
        >
          <motion.span
            className="w-2 h-2 rounded-full bg-destructive"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          />
          <span className="text-[11px] font-medium">REC</span>
          <span className="text-[11px] font-mono tabular-nums">
            {formatDuration(event.durationMs)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {formatBytes(event.approxBytes)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive hover:text-destructive"
            onClick={onStop}
            aria-label="停止录制"
            disabled={event.state === "stopping"}
          >
            <CircleStop className="w-3.5 h-3.5" />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
