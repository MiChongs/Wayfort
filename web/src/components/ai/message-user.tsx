"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Check, Copy, Pencil, X } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAutosizeTextarea } from "@/lib/hooks/use-autosize-textarea"
import type { AIMessage } from "@/lib/api/types"

// Claude.ai-style user turn: a right-aligned, soft rounded bubble with NO
// avatar. Copy / edit actions live in a quiet row beneath the bubble that
// fades in on hover (the row's height is always reserved so the surrounding
// rhythm never jumps).
export const UserBubble = React.memo(function UserBubble({
  text,
  images,
  message,
  onEdit,
}: {
  text: string
  images?: string[]
  message?: AIMessage
  onEdit?: (msg: AIMessage, newText: string) => void
}) {
  const reduce = useReducedMotion()
  const [editing, setEditing] = React.useState(false)
  const [zoom, setZoom] = React.useState<string | null>(null)
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
      <div className="flex justify-end">
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduce ? { duration: 0 } : { duration: 0.18 }}
          className="w-full max-w-[37rem] rounded-3xl rounded-tr-lg border border-border bg-secondary p-2 shadow-sm"
        >
          <Textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
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
            className="min-h-[44px] resize-none border-0 bg-transparent px-2 py-1 text-[15px] shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center justify-end gap-1 border-t border-border/70 pt-1.5">
            <span className="mr-auto pl-2 text-[10px] text-muted-foreground">
              ⌘/Ctrl+Enter 保存并重发 · Esc 取消
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(false)}
              className="h-7 px-2"
            >
              <X className="h-3.5 w-3.5" /> 取消
            </Button>
            <Button type="button" size="sm" onClick={commit} className="h-7 px-3">
              <Check className="h-3.5 w-3.5" /> 保存并重发
            </Button>
          </div>
        </motion.div>
      </div>
    )
  }

  return (
    <>
      <div className="group flex flex-col items-end gap-1">
        {images && images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt="附件图片"
                onClick={() => setZoom(src)}
                className="max-h-44 max-w-[12rem] cursor-zoom-in rounded-2xl border border-border object-cover shadow-sm transition-opacity hover:opacity-90"
              />
            ))}
          </div>
        )}
        {text && (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl rounded-tr-lg bg-secondary px-4 py-2.5 text-[15px] leading-relaxed text-foreground md:max-w-[37rem]">
            {text}
          </div>
        )}

        {/* Quiet action row under the bubble — Claude.ai style. Height is always
            reserved (h-7) so hovering never nudges the layout. */}
        <div className="flex h-7 items-center gap-0.5 pr-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={doCopy}
                aria-label="复制"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">复制</TooltipContent>
          </Tooltip>
          {message && onEdit && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditing(true)}
                  aria-label="编辑并重发"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">编辑并重发（会清除之后的回复）</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {zoom && (
        <div
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="附件图片" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  )
})
