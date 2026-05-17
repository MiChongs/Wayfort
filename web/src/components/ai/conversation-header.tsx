"use client"

import * as React from "react"
import { motion } from "motion/react"
import { MoreHorizontal, RefreshCw, Sparkles, Trash2, Download, Edit3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ModeSwitcher } from "./mode-switcher"
import { AgentAvatar } from "./agent-avatar"
import type { AIAgent, AIConversation, PermissionMode } from "@/lib/api/types"

export function ConversationHeader({
  conversation,
  agent,
  liveTokensIn,
  liveTokensOut,
  onModeChange,
  onRegenerate,
  onRename,
  onDelete,
  onExport,
  running,
}: {
  conversation?: AIConversation
  agent?: AIAgent
  liveTokensIn: number
  liveTokensOut: number
  onModeChange: (m: PermissionMode) => void
  onRegenerate: () => void
  onRename: (title: string) => void
  onDelete: () => void
  onExport: () => void
  running: boolean
}) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(conversation?.title || "")

  React.useEffect(() => {
    setDraft(conversation?.title || "")
  }, [conversation?.title])

  const tokensIn = (conversation?.total_input_tokens || 0) + liveTokensIn
  const tokensOut = (conversation?.total_output_tokens || 0) + liveTokensOut

  function commitRename() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== conversation?.title) onRename(trimmed)
    else setDraft(conversation?.title || "")
  }

  return (
    <div className="border-b px-4 md:px-6 py-3 flex items-center justify-between gap-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="min-w-0 flex-1 flex items-center gap-3">
        <AgentAvatar agent={agent} />
        <div className="min-w-0 flex-1">
          <div className="font-medium flex items-center gap-2 truncate">
            <motion.div
              initial={{ rotate: -20, opacity: 0 }}
              animate={{ rotate: 0, opacity: 1 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="shrink-0"
            >
              <Sparkles className="w-4 h-4 text-primary" />
            </motion.div>
            {editing ? (
              <Input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename()
                  if (e.key === "Escape") {
                    setEditing(false)
                    setDraft(conversation?.title || "")
                  }
                }}
                className="h-7 max-w-md"
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onDoubleClick={() => setEditing(true)}
                    className="truncate hover:underline decoration-dotted underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
                  >
                    {conversation?.title || "新对话"}
                  </button>
                </TooltipTrigger>
                <TooltipContent>双击重命名</TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
            {agent?.name && (
              <>
                <span className="truncate max-w-[160px]">{agent.name}</span>
                <span>·</span>
              </>
            )}
            <span className="font-mono">{conversation?.model || "—"}</span>
            <span>·</span>
            <span>↑ {tokensIn.toLocaleString()}</span>
            <span>/</span>
            <span>↓ {tokensOut.toLocaleString()}</span>
            <span>·</span>
            <span>{conversation?.message_count || 0} 条消息</span>
            {running && (
              <motion.span
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                className="ml-1 inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-current" />
                生成中
              </motion.span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <ModeSwitcher
          value={conversation?.permission_mode || "normal"}
          onChange={onModeChange}
          size="sm"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onRegenerate}
              aria-label="重发最后一条用户消息"
              className="h-8 w-8"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>重发最后一条</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="更多操作"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>更多操作</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Edit3 className="w-3.5 h-3.5" /> 重命名
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExport}>
              <Download className="w-3.5 h-3.5" /> 导出 JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="w-3.5 h-3.5" /> 删除对话
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
