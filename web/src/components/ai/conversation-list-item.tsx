"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import Link from "next/link"
import { MoreHorizontal, Trash2, Edit3 } from "lucide-react"
import { toast } from "sonner"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { aiConversationService } from "@/lib/api/services"
import { relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AIAgent, AIConversation } from "@/lib/api/types"

export function ConversationListItem({
  conv,
  agent,
  active,
  onSelect,
}: {
  conv: AIConversation
  agent?: AIAgent
  active: boolean
  onSelect?: () => void
}) {
  const qc = useQueryClient()
  const reduce = useReducedMotion()
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(conv.title || "新对话")

  React.useEffect(() => {
    setDraft(conv.title || "新对话")
  }, [conv.title])

  const remove = useMutation({
    mutationFn: () => aiConversationService.remove(conv.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      toast.success("已删除对话")
    },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })

  const rename = useMutation({
    mutationFn: (title: string) => aiConversationService.update(conv.id, { title }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "convs"] }),
  })

  async function askDelete() {
    const ok = await confirmDialog({
      title: "删除这条对话？",
      description: "所有消息和工具调用都会被删除。",
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  function commitRename() {
    setEditing(false)
    const t = draft.trim()
    if (t && t !== conv.title) rename.mutate(t)
    else setDraft(conv.title || "新对话")
  }

  return (
    <motion.li
      layout="position"
      initial={reduce ? false : { opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -16, scale: 0.95 }}
      transition={
        reduce ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 28 }
      }
      className={cn(
        "relative rounded-lg group transition-colors",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      {active && (
        <motion.span
          layoutId="sidebar-active-bar"
          className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-primary"
          transition={
            reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 30 }
          }
        />
      )}
      {editing ? (
        <div className="px-3 py-2">
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename()
              if (e.key === "Escape") {
                setEditing(false)
                setDraft(conv.title || "新对话")
              }
            }}
            className="h-7 text-sm"
          />
        </div>
      ) : (
        <Link
          href={`/ai/conversations/${conv.id}` as Parameters<typeof Link>[0]["href"]}
          onClick={onSelect}
          className="block px-3 py-2 pr-9 min-w-0"
        >
          <div className="text-sm font-medium truncate">
            {conv.title || "新对话"}
          </div>
          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5">
            <span className="truncate">{agent?.name || `agent#${conv.agent_id}`}</span>
            <Badge variant="outline" className="text-[9px] h-3.5 px-1 leading-none">
              {conv.permission_mode}
            </Badge>
            <span className="ml-auto whitespace-nowrap">{relTime(conv.updated_at)}</span>
          </div>
        </Link>
      )}

      {!editing && (
        <div
          className={cn(
            "absolute right-1 top-1.5 transition-opacity",
            active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={(e) => e.preventDefault()}
                    aria-label="对话操作"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">更多操作</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Edit3 className="w-3.5 h-3.5" /> 重命名
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={askDelete}
              >
                <Trash2 className="w-3.5 h-3.5" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </motion.li>
  )
}
