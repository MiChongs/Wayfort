"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { Loader2, Send, Pause, CornerDownLeft } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useAutosizeTextarea } from "@/lib/hooks/use-autosize-textarea"
import { cn } from "@/lib/utils"

export type SlashHint = { cmd: string; desc: string; danger?: boolean }

export const SLASH_COMMANDS: SlashHint[] = [
  { cmd: "/clear", desc: "清空本对话（不可恢复）", danger: true },
  { cmd: "/plan", desc: "切到 plan 模式（dry-run）" },
  { cmd: "/normal", desc: "切到 normal 模式（写需确认）" },
  { cmd: "/bypass", desc: "切到 bypass 模式（直接执行）" },
  { cmd: "/cancel", desc: "中断当前生成" },
]

export const Composer = React.forwardRef<
  HTMLTextAreaElement,
  {
    draft: string
    setDraft: (s: string) => void
    send: () => void
    cancel?: () => void
    running: boolean
    placeholder?: string
    rightSlot?: React.ReactNode
  }
>(function Composer(
  { draft, setDraft, send, cancel, running, placeholder, rightSlot },
  ref,
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)
  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement)
  useAutosizeTextarea(innerRef, draft, 240)
  const reduce = useReducedMotion()

  const slashHint = React.useMemo<SlashHint[] | null>(() => {
    if (!draft.startsWith("/")) return null
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(draft.toLowerCase()))
  }, [draft])

  const charCount = draft.length

  return (
    <div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-3 md:px-4 pt-3 pb-3 relative">
      <AnimatePresence>
        {slashHint && slashHint.length > 0 && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={reduce ? { duration: 0 } : { duration: 0.16 }}
            className="absolute bottom-full left-3 right-3 mb-2 rounded-lg border bg-popover shadow-lg p-1.5"
          >
            {slashHint.map((c) => (
              <button
                key={c.cmd}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setDraft(c.cmd)
                }}
                className="w-full text-left flex items-center gap-2 text-sm px-2 py-1.5 rounded hover:bg-accent transition-colors"
              >
                <code className="font-mono text-xs">{c.cmd}</code>
                <span className="text-xs text-muted-foreground">{c.desc}</span>
                {c.danger && (
                  <Badge variant="destructive" className="ml-auto h-4 text-[10px]">
                    危险
                  </Badge>
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="rounded-2xl border bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring/40 focus-within:border-ring/40 transition-all">
        <Textarea
          ref={innerRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={
            placeholder ||
            "输入你的指令… （Enter 发送，Shift+Enter 换行，斜杠开头查看快捷命令）"
          }
          rows={1}
          className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 px-4 pt-3 pb-1 min-h-[44px]"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground pl-2">
            {rightSlot}
            <span className="hidden md:inline-flex items-center gap-1 opacity-70">
              <CornerDownLeft className="w-3 h-3" /> 发送
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-[10px] font-mono",
                charCount > 4000 ? "text-amber-500" : "text-muted-foreground/70",
              )}
            >
              {charCount}
            </span>
            {running && cancel ? (
              <motion.div whileTap={reduce ? undefined : { scale: 0.96 }}>
                <Button size="sm" variant="outline" onClick={cancel}>
                  <Pause className="w-4 h-4" /> 停止
                </Button>
              </motion.div>
            ) : (
              <motion.div whileTap={reduce ? undefined : { scale: 0.96 }}>
                <Button
                  size="sm"
                  onClick={send}
                  disabled={running || !draft.trim()}
                  className="px-4"
                >
                  {running ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  发送
                </Button>
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
