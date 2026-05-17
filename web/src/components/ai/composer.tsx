"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Loader2, Send, Pause, CornerDownLeft } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

  const slashOpen = draft.startsWith("/")
  const filteredCommands = React.useMemo(() => {
    if (!slashOpen) return SLASH_COMMANDS
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(draft.toLowerCase()))
  }, [slashOpen, draft])

  const charCount = draft.length

  function pickCommand(cmd: string) {
    setDraft(cmd)
    // keep focus on the textarea
    requestAnimationFrame(() => innerRef.current?.focus())
  }

  return (
    <div className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-3 md:px-4 pt-3 pb-3 relative">
      <Popover open={slashOpen && filteredCommands.length > 0}>
        <PopoverAnchor asChild>
          <div className="rounded-2xl border bg-background shadow-sm focus-within:ring-2 focus-within:ring-ring/40 focus-within:border-ring/40 transition-all">
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
                    charCount > 4000
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground/70",
                  )}
                >
                  {charCount}
                </span>
                {running && cancel ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <motion.div whileTap={reduce ? undefined : { scale: 0.96 }}>
                        <Button size="sm" variant="outline" onClick={cancel}>
                          <Pause className="w-4 h-4" /> 停止
                        </Button>
                      </motion.div>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      中断当前生成（Esc 也可）
                    </TooltipContent>
                  </Tooltip>
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
        </PopoverAnchor>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="w-[min(420px,calc(100vw-2rem))] p-0"
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
                    className="flex items-center gap-2"
                  >
                    <code className="font-mono text-xs text-foreground">
                      {c.cmd}
                    </code>
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
