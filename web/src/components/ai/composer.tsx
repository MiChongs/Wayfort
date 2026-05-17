"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  Command as CommandIcon,
  CornerDownLeft,
  Loader2,
  Pause,
  Send,
  SlashIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
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
    leftSlot?: React.ReactNode
  }
>(function Composer(
  { draft, setDraft, send, cancel, running, placeholder, leftSlot },
  ref,
) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)
  React.useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement)
  useAutosizeTextarea(innerRef, draft, 220)
  const reduce = useReducedMotion()

  const slashOpen = draft.startsWith("/")
  const filteredCommands = React.useMemo(() => {
    if (!slashOpen) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(draft.toLowerCase()))
  }, [slashOpen, draft])

  const charCount = draft.length
  const overLimit = charCount > 8000
  const canSend = draft.trim().length > 0 && !running

  function pickCommand(cmd: string) {
    setDraft(cmd)
    requestAnimationFrame(() => innerRef.current?.focus())
  }

  return (
    <div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70 px-3 md:px-4 pt-3 pb-3 relative">
      <Popover open={slashOpen && filteredCommands.length > 0}>
        <PopoverAnchor asChild>
          <Card
            className={cn(
              "p-0 gap-0 rounded-2xl shadow-sm transition-all overflow-hidden",
              "border-border/70 bg-background",
              "focus-within:border-ring/40 focus-within:ring-2 focus-within:ring-ring/30 focus-within:shadow-md",
            )}
          >
            <div className="px-3 pt-2.5">
              <Textarea
                ref={innerRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder={
                  placeholder ||
                  "输入你的指令…（Enter 发送 · Shift+Enter 换行 · / 看快捷命令）"
                }
                rows={1}
                className={cn(
                  "resize-none border-0 bg-transparent shadow-none px-1 py-1.5",
                  "min-h-[28px] text-sm leading-relaxed",
                  "focus-visible:ring-0 focus-visible:ring-offset-0",
                  "placeholder:text-muted-foreground/70",
                )}
              />
            </div>
            <Separator className="opacity-40" />
            <div className="flex items-center justify-between gap-2 px-2 py-1.5">
              <div className="flex items-center gap-1.5 pl-1 min-w-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-muted-foreground hover:text-foreground gap-1"
                      onClick={() => {
                        setDraft("/")
                        innerRef.current?.focus()
                      }}
                    >
                      <SlashIcon className="w-3.5 h-3.5" />
                      <span className="text-[11px]">命令</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">查看快捷命令</TooltipContent>
                </Tooltip>
                {leftSlot}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge
                  variant={overLimit ? "warning" : "secondary"}
                  className={cn(
                    "h-5 px-1.5 text-[10px] font-mono tabular-nums transition-colors",
                    !overLimit && charCount > 0
                      ? "bg-muted text-muted-foreground"
                      : "",
                    charCount === 0 && "opacity-0 pointer-events-none",
                  )}
                >
                  {charCount}
                </Badge>
                <span className="hidden md:inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <CornerDownLeft className="w-3 h-3" />
                  发送
                </span>
                {running && cancel ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <motion.div whileTap={reduce ? undefined : { scale: 0.95 }}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={cancel}
                          className="h-8 px-3"
                        >
                          <Pause className="w-3.5 h-3.5" />
                          <span>停止</span>
                        </Button>
                      </motion.div>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      中断生成（Esc）
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <motion.div
                        whileTap={reduce || !canSend ? undefined : { scale: 0.94 }}
                      >
                        <Button
                          type="button"
                          size="sm"
                          onClick={send}
                          disabled={!canSend}
                          className="h-8 px-3 gap-1.5 rounded-lg"
                        >
                          {running ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          <span>发送</span>
                        </Button>
                      </motion.div>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="flex items-center gap-1">
                      Enter <Separator orientation="vertical" className="h-3 mx-0.5" /> 发送
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </Card>
        </PopoverAnchor>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="w-[min(420px,calc(100vw-2rem))] p-0 border-border/70"
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
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <CommandIcon className="w-3.5 h-3.5 text-muted-foreground" />
                    <code className="font-mono text-xs text-foreground">{c.cmd}</code>
                    <span className="text-xs text-muted-foreground truncate">
                      {c.desc}
                    </span>
                    {c.danger && (
                      <Badge
                        variant="destructive"
                        className="ml-auto h-4 text-[10px]"
                      >
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
    </div>
  )
})
