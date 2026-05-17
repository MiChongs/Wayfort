"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ArrowDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { UserBubble } from "./message-user"
import { AssistantBubble } from "./message-assistant"
import { ToolCard, type ToolStatus } from "./tool-card"
import { PermissionPrompt } from "./permission-prompt"
import { ThinkingIndicator } from "./thinking-indicator"
import { isDangerName } from "./tool-icons"
import type { AIMessage, AIToolInvocation } from "@/lib/api/types"

export type LiveBubble =
  | { kind: "user"; text: string }
  | { kind: "assistant"; chunks: string[]; streaming: boolean }
  | {
      kind: "tool"
      id: string
      invocationId?: string
      name: string
      status: ToolStatus
      output?: string
      error?: string
      danger?: boolean
    }
  | {
      kind: "permission"
      invocationId: string
      tool: string
      summary: string
      danger?: boolean
    }

interface MessageListProps {
  messages: AIMessage[]
  invocations: AIToolInvocation[]
  live: LiveBubble[]
  running: boolean
  thinking: boolean
  onApprove: (id: string) => void
  onReject: (id: string) => void
}

export function MessageList({
  messages,
  invocations,
  live,
  running,
  thinking,
  onApprove,
  onReject,
}: MessageListProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const reduce = useReducedMotion()
  const [autoFollow, setAutoFollow] = React.useState(true)

  // Auto-scroll to bottom when content grows, but only if user hasn't scrolled
  // up (so we don't yank them away from history they're reading).
  React.useEffect(() => {
    if (!autoFollow) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, live, running, autoFollow])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAutoFollow(atBottom)
  }

  function jumpLatest() {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    setAutoFollow(true)
  }

  const historyBubbles = React.useMemo(
    () => renderHistory(messages, invocations),
    [messages, invocations],
  )

  const emptyState =
    historyBubbles.length === 0 && live.length === 0 && !running && !thinking

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto px-3 md:px-6 py-6 space-y-4 bg-gradient-to-b from-muted/20 to-muted/40"
      >
        {emptyState && <EmptyChat />}

        <AnimatePresence initial={false}>
          {historyBubbles.map((b) => (
            <motion.div
              key={`h-${b.key}`}
              layout="position"
              initial={reduce ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 320, damping: 28, mass: 0.6 }
              }
            >
              {b.node}
            </motion.div>
          ))}

          {live.map((b, i) => {
            const k = liveKey(b, i)
            return (
              <motion.div
                key={`l-${k}`}
                layout="position"
                initial={reduce ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 320, damping: 28, mass: 0.6 }
                }
              >
                <LiveBubbleView b={b} onApprove={onApprove} onReject={onReject} />
              </motion.div>
            )
          })}

          {thinking && (
            <motion.div
              key="thinking"
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={reduce ? { duration: 0 } : { duration: 0.2 }}
            >
              <ThinkingIndicator />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {!autoFollow && (
          <motion.div
            initial={reduce ? false : { opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8, y: 10 }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 28 }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2"
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={jumpLatest}
              className="shadow-lg backdrop-blur"
            >
              <ArrowDown className="w-3.5 h-3.5" /> 返回最新
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function LiveBubbleView({
  b,
  onApprove,
  onReject,
}: {
  b: LiveBubble
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  if (b.kind === "user") return <UserBubble text={b.text} />
  if (b.kind === "assistant") {
    if (b.chunks.length === 0 && b.streaming) return null
    return <AssistantBubble chunks={b.chunks} streaming={b.streaming} />
  }
  if (b.kind === "tool")
    return (
      <ToolCard
        name={b.name}
        status={b.status}
        output={b.output}
        error={b.error}
        danger={b.danger}
      />
    )
  if (b.kind === "permission")
    return (
      <PermissionPrompt
        invocationId={b.invocationId}
        tool={b.tool}
        summary={b.summary}
        onApprove={onApprove}
        onReject={onReject}
      />
    )
  return null
}

function liveKey(b: LiveBubble, i: number): string {
  switch (b.kind) {
    case "user":
      return `u-${i}`
    case "assistant":
      return `a-${i}`
    case "tool":
      return `t-${b.id}`
    case "permission":
      return `p-${b.invocationId}`
  }
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-3"
      >
        <span className="text-2xl">✨</span>
      </motion.div>
      <div className="text-sm font-medium">开始一段对话</div>
      <div className="text-xs text-muted-foreground mt-1">
        在下方输入指令，Agent 会按当前模式协助你
      </div>
    </div>
  )
}

// ---------- Persisted history rendering ----------

type RenderedBubble = { key: string; node: React.ReactNode }

function renderHistory(
  messages: AIMessage[],
  invocations: AIToolInvocation[],
): RenderedBubble[] {
  const out: RenderedBubble[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const text = parseContentText(m.content)
    if (m.role === "user") {
      out.push({ key: `u-${m.id}`, node: <UserBubble text={text} /> })
    } else if (m.role === "assistant") {
      if (text) {
        out.push({ key: `a-${m.id}`, node: <AssistantBubble text={text} /> })
      }
      if (m.tool_calls) {
        try {
          const tcs = JSON.parse(m.tool_calls) as {
            id: string
            name: string
            arguments: string
          }[]
          for (const tc of tcs) {
            let result = ""
            for (let j = i + 1; j < messages.length; j++) {
              if (
                messages[j].role === "tool" &&
                messages[j].tool_call_id === tc.id
              ) {
                result = parseContentText(messages[j].content)
                break
              }
            }
            const inv = invocations.find((iv) => iv.tool_name === tc.name)
            const status: ToolStatus =
              inv?.status === "failed" || inv?.status === "rejected"
                ? "error"
                : inv?.status === "dry_run"
                ? "dry_run"
                : inv?.status === "pending" || inv?.status === "running"
                ? "running"
                : "output"
            out.push({
              key: `t-${m.id}-${tc.id}`,
              node: (
                <ToolCard
                  name={tc.name}
                  status={status}
                  output={result || inv?.output}
                  error={inv?.error}
                  danger={isDangerName(tc.name)}
                  defaultExpanded={false}
                />
              ),
            })
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out
}

function parseContentText(s: string): string {
  try {
    const parts = JSON.parse(s) as { text?: string }[]
    return parts.map((p) => p.text || "").join("")
  } catch {
    return s || ""
  }
}
