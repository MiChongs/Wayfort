"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  ArrowUp,
  Brain,
  Check,
  Command as CommandIcon,
  Loader2,
  Paperclip,
  SlashIcon,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAutosizeTextarea } from "@/lib/hooks/use-autosize-textarea"
import { cn } from "@/lib/utils"

export type SlashHint = { cmd: string; desc: string; danger?: boolean }

export const SLASH_COMMANDS: SlashHint[] = [
  { cmd: "/clear", desc: "清空本对话（不可恢复）", danger: true },
  { cmd: "/plan", desc: "切到 plan 模式（只读规划）" },
  { cmd: "/normal", desc: "切到 normal 模式（写需确认）" },
  { cmd: "/bypass", desc: "切到 bypass 模式（直接执行）" },
  { cmd: "/cancel", desc: "中断当前生成" },
]

// Extended-thinking tiers. The budget is the token allowance the provider gets
// for chain-of-thought before answering.
export const THINK_TIERS: { v: number; label: string; hint: string }[] = [
  { v: 0, label: "关闭", hint: "不进行扩展思考，直接作答" },
  { v: 4096, label: "快", hint: "轻量推理，响应更快" },
  { v: 10240, label: "标准", hint: "平衡推理深度与速度" },
  { v: 24576, label: "深度", hint: "最深推理，适合复杂排查" },
]

const MAX_IMAGES = 6

export const Composer = React.forwardRef<
  HTMLTextAreaElement,
  {
    draft: string
    setDraft: (s: string) => void
    send: () => void
    cancel?: () => void
    running: boolean
    placeholder?: string
    leftSlot?: React.ReactNode
    attachments?: string[]
    onAttachmentsChange?: (imgs: string[]) => void
    /** Whether the current model supports image input. Undefined = unknown
        (show the attach affordance); false = hide it. */
    vision?: boolean
    thinkingBudget?: number
    onSetThinkingBudget?: (n: number) => void
  }
>(function Composer(
  {
    draft,
    setDraft,
    send,
    cancel,
    running,
    placeholder,
    leftSlot,
    attachments,
    onAttachmentsChange,
    vision,
    thinkingBudget,
    onSetThinkingBudget,
  },
  ref,
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)
  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement)
  useAutosizeTextarea(innerRef, draft, 200)
  const reduce = useReducedMotion()
  const fileRef = React.useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [thinkOpen, setThinkOpen] = React.useState(false)

  const imgs = attachments ?? []
  // Hide the attach affordance only when the model is known NOT to support
  // vision; undefined capability falls through to "allowed".
  const canAttach = !!onAttachmentsChange && vision !== false

  const slashOpen = draft.startsWith("/")
  const filteredCommands = React.useMemo(() => {
    if (!slashOpen) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(draft.toLowerCase()))
  }, [slashOpen, draft])

  const charCount = draft.length
  const overLimit = charCount > 8000
  const canSend = (draft.trim().length > 0 || imgs.length > 0) && !running

  const tier = THINK_TIERS.find((t) => t.v === (thinkingBudget ?? 0)) ?? THINK_TIERS[0]
  const thinkingOn = (thinkingBudget ?? 0) > 0

  function pickCommand(cmd: string) {
    setDraft(cmd)
    requestAnimationFrame(() => innerRef.current?.focus())
  }

  function addFiles(list: FileList | File[]) {
    if (!onAttachmentsChange) return
    const files = Array.from(list).filter((f) => f.type.startsWith("image/"))
    if (files.length === 0) return
    Promise.all(
      files.map(
        (f) =>
          new Promise<string>((res, rej) => {
            const r = new FileReader()
            r.onload = () => res(String(r.result))
            r.onerror = rej
            r.readAsDataURL(f)
          }),
      ),
    ).then((urls) => onAttachmentsChange([...imgs, ...urls].slice(0, MAX_IMAGES)))
  }

  function removeImage(i: number) {
    onAttachmentsChange?.(imgs.filter((_, idx) => idx !== i))
  }

  return (
    <div className="bg-gradient-to-t from-background via-background/95 to-transparent px-3 pb-4 pt-3 md:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <Popover open={slashOpen && filteredCommands.length > 0}>
          <PopoverAnchor asChild>
            <div
              onDragOver={(e) => {
                if (!canAttach) return
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                if (!canAttach) return
                e.preventDefault()
                setDragging(false)
                if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
              }}
              className={cn(
                "relative rounded-[28px] border border-border/70 bg-background shadow-sm transition-all",
                "focus-within:border-ring/40 focus-within:shadow-md",
                dragging && "border-primary/60 ring-2 ring-primary/20",
              )}
            >
              {/* Attachment thumbnails */}
              {imgs.length > 0 && (
                <div className="flex flex-wrap gap-2 px-4 pt-3">
                  {imgs.map((src, i) => (
                    <div key={i} className="group/att relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt="待发送图片"
                        className="h-16 w-16 rounded-lg border border-border object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground"
                        aria-label="移除图片"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <Textarea
                ref={innerRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  if (!canAttach) return
                  const files = Array.from(e.clipboardData.items)
                    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
                    .map((it) => it.getAsFile())
                    .filter((f): f is File => !!f)
                  if (files.length) {
                    e.preventDefault()
                    addFiles(files)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder={placeholder || "给 Agent 下达指令…"}
                rows={1}
                className={cn(
                  "max-h-[200px] resize-none border-none bg-transparent px-5 pt-4 pb-1 shadow-none",
                  "text-[15px] leading-relaxed placeholder:text-muted-foreground/60",
                  "outline-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0",
                )}
              />

              {/* Bottom toolbar */}
              <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-0.5">
                {canAttach && (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        if (e.target.files?.length) addFiles(e.target.files)
                        e.target.value = ""
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                          onClick={() => fileRef.current?.click()}
                          aria-label="添加图片"
                        >
                          <Paperclip className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">添加图片（也可粘贴 / 拖入）</TooltipContent>
                    </Tooltip>
                  </>
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setDraft("/")
                        innerRef.current?.focus()
                      }}
                      aria-label="斜杠命令"
                    >
                      <SlashIcon className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">斜杠命令</TooltipContent>
                </Tooltip>

                {onSetThinkingBudget && (
                  <Popover open={thinkOpen} onOpenChange={setThinkOpen}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={cn(
                              "h-8 gap-1.5 rounded-full px-2.5 text-xs transition-colors",
                              thinkingOn
                                ? "bg-primary/12 text-primary hover:bg-primary/18"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <Brain className="h-3.5 w-3.5" />
                            深度思考{thinkingOn && ` · ${tier.label}`}
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[240px]">
                        扩展思考：模型先进行更长的链式推理再作答（仅 Claude / o-系 等支持的模型生效）。
                      </TooltipContent>
                    </Tooltip>
                    <PopoverContent side="top" align="start" className="w-56 p-1">
                      {THINK_TIERS.map((t) => {
                        const on = t.v === (thinkingBudget ?? 0)
                        return (
                          <button
                            key={t.v}
                            type="button"
                            onClick={() => {
                              onSetThinkingBudget(t.v)
                              setThinkOpen(false)
                            }}
                            className={cn(
                              "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                              on && "bg-accent",
                            )}
                          >
                            <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", on ? "text-primary" : "opacity-0")} />
                            <span className="min-w-0">
                              <span className="font-medium">{t.label}</span>
                              <span className="block text-[11px] leading-relaxed text-muted-foreground">{t.hint}</span>
                            </span>
                          </button>
                        )
                      })}
                    </PopoverContent>
                  </Popover>
                )}

                {leftSlot}

                <div className="ml-auto flex items-center gap-2">
                  {charCount > 0 && (
                    <Badge
                      variant={overLimit ? "warning" : "secondary"}
                      className={cn(
                        "h-5 px-1.5 font-mono text-[10px] tabular-nums",
                        !overLimit && "bg-transparent text-muted-foreground/60",
                      )}
                    >
                      {charCount.toLocaleString()}
                    </Badge>
                  )}

                  {running && cancel ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <motion.button
                          type="button"
                          onClick={cancel}
                          whileTap={reduce ? undefined : { scale: 0.92 }}
                          className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/85"
                          aria-label="停止生成"
                        >
                          <span className="h-3 w-3 rounded-[3px] bg-current" />
                        </motion.button>
                      </TooltipTrigger>
                      <TooltipContent side="top">停止生成（Esc）</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <motion.button
                          type="button"
                          onClick={send}
                          disabled={!canSend}
                          whileTap={reduce || !canSend ? undefined : { scale: 0.92 }}
                          className={cn(
                            "flex h-9 w-9 items-center justify-center rounded-full transition-colors",
                            canSend
                              ? "bg-primary text-primary-foreground hover:bg-primary/90"
                              : "bg-muted text-muted-foreground",
                          )}
                          aria-label="发送"
                        >
                          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                        </motion.button>
                      </TooltipTrigger>
                      <TooltipContent side="top">Enter 发送 · Shift+Enter 换行</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>
          </PopoverAnchor>

          <PopoverContent
            side="top"
            align="start"
            sideOffset={10}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            className="w-[min(420px,calc(100vw-2rem))] border-border/70 p-0"
          >
            <Command shouldFilter={false}>
              <CommandList className="max-h-[260px]">
                <CommandEmpty>没有匹配的命令</CommandEmpty>
                <CommandGroup heading="斜杠命令">
                  {filteredCommands.map((c) => (
                    <CommandItem
                      key={c.cmd}
                      value={c.cmd}
                      onSelect={() => pickCommand(c.cmd)}
                      className="flex cursor-pointer items-center gap-2"
                    >
                      <CommandIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      <code className="font-mono text-xs text-foreground">{c.cmd}</code>
                      <span className="truncate text-xs text-muted-foreground">{c.desc}</span>
                      {c.danger && (
                        <Badge variant="destructive" className="ml-auto h-4 text-[10px]">
                          危险
                        </Badge>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <div className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
          AI 可能出错；高危操作会请求你的确认。Enter 发送 · Shift+Enter 换行
        </div>
      </div>
    </div>
  )
})
