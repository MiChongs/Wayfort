"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Check, Copy, Pencil, User, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAutosizeTextarea } from "@/lib/hooks/use-autosize-textarea"
import { cn } from "@/lib/utils"
import type { AIMessage } from "@/lib/api/types"

export const UserBubble = React.memo(function UserBubble({
  text,
  message,
  onEdit,
}: {
  text: string
  message?: AIMessage
  onEdit?: (msg: AIMessage, newText: string) => void
}) {
  const reduce = useReducedMotion()
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(text)
  const taRef = React.useRef<HTMLTextAreaElement | null>(null)
  useAutosizeTextarea(taRef, draft, 320)

  React.useEffect(() => {
    if (editing) setDraft(text)
  }, [editing, text])

  async function doCopy() {
    try {
      await navigator.clipboard.writeText(text)
      toast.success("已复制")
    } catch {
      toast.error("复制失败")
    }
  }

  function commit() {
    const t = draft.trim()
    if (!t) {
      toast.error("内容不能为空")
      return
    }
    if (!message || !onEdit) {
      setEditing(false)
      return
    }
    if (t === text) {
      setEditing(false)
      return
    }
    onEdit(message, t)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex justify-end gap-3 group">
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduce ? { duration: 0 } : { duration: 0.18 }}
          className="bg-primary/5 border border-primary/30 rounded-2xl rounded-tr-md p-2 max-w-[80%] md:max-w-2xl shadow-sm"
        >
          <Textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                commit()
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setEditing(false)
              }
            }}
            className="resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 px-2 py-1 min-h-[44px] text-sm"
          />
          <div className="flex items-center justify-end gap-1 pt-1.5 border-t border-primary/20 mt-1">
            <span className="text-[10px] text-muted-foreground mr-2 self-center">
              ⌘+Enter 保存 · Esc 取消
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              className="h-7 px-2"
            >
              <X className="w-3.5 h-3.5" /> 取消
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={commit}
              className="h-7 px-3"
            >
              <Check className="w-3.5 h-3.5" /> 保存并重发
            </Button>
          </div>
        </motion.div>
        <div className="w-7 h-7 rounded-full bg-primary/90 text-primary-foreground flex items-center justify-center shrink-0 shadow-sm">
          <User className="w-4 h-4" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-end gap-3 group">
      <div
        className={cn(
          "flex items-start gap-0.5 self-start mt-1",
          "rounded-md border bg-background/85 backdrop-blur shadow-sm p-0.5",
          "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={doCopy}
              aria-label="复制"
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">复制</TooltipContent>
        </Tooltip>
        {message && onEdit && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setEditing(true)}
                aria-label="编辑并重发"
              >
                <Pencil className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">编辑并重发（会清除之后的回复）</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-md px-4 py-2.5 max-w-[80%] md:max-w-2xl whitespace-pre-wrap break-words shadow-sm">
        {text}
      </div>
      <div className="w-7 h-7 rounded-full bg-primary/90 text-primary-foreground flex items-center justify-center shrink-0 shadow-sm">
        <User className="w-4 h-4" />
      </div>
    </div>
  )
})
