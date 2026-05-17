"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ArrowDown, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EmptyState } from "@/components/common/empty-state"
import { UserBubble } from "./message-user"
import { AssistantBubble } from "./message-assistant"
import { ToolCard, type ToolStatus } from "./tool-card"
import { PermissionPrompt } from "./permission-prompt"
import { ThinkingIndicator } from "./thinking-indicator"
import { SystemNotice, type NoticeLevel } from "./system-notice"
import { SubAgentCard } from "./subagent-card"
import { MessageSkeleton } from "./message-skeleton"
import { isDangerName } from "./tool-icons"
import type { AIAgent, AIMessage, AIToolInvocation } from "@/lib/api/types"

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
  | {
      kind: "system_notice"
      id: string
      level: NoticeLevel
      title: string
      description?: string
      retryable?: boolean
    }
  | {
      kind: "subagent"
      id: string
      agent: string
      eventKind?: string
      text?: string
      payload?: string
    }

interface MessageListProps {
  messages: AIMessage[]
  invocations: AIToolInvocation[]
  live: LiveBubble[]
  running: boolean
  thinking: boolean
  loading?: boolean
  agent?: AIAgent
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onRetry?: () => void
}

export function MessageList({
  messages,
  invocations,
  live,
  running,
  thinking,
  loading,
  agent,
  onApprove,
  onReject,
  onRetry,
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

  // scroll events don't bubble; attach the listener directly on the viewport.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function handle() {
      if (!el) return
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      setAutoFollow(atBottom)
    }
    el.addEventListener("scroll", handle, { passive: true })
    return () => el.removeEventListener("scroll", handle)
  }, [])

  function jumpLatest() {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    setAutoFollow(true)
  }

  const historyBubbles = React.useMemo(
    () => renderHistory(messages, invocations, agent),
    [messages, invocations, agent],
  )

  const showSkeleton = loading && historyBubbles.length === 0 && live.length === 0
  const emptyState =
    !showSkeleton &&
    historyBubbles.length === 0 &&
    live.length === 0 &&
    !running &&
    !thinking

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <ScrollArea
        viewportRef={scrollRef}
        className="absolute inset-0 bg-muted/20"
      >
        <div className="px-3 md:px-6 py-6 space-y-4 min-w-0">
        {showSkeleton && <MessageSkeleton />}

        {emptyState && (
          <div className="py-16">
            <EmptyState
              icon={Sparkles}
              title="开始一段对话"
              description="在下方输入指令，Agent 会按当前模式协助你；高危工具会请求你的确认。"
            />
          </div>
        )}

        <AnimatePresence initial={false}>
          {historyBubbles.map((b) => (
            <motion.div
              key={`h-${b.key}`}
              layout={reduce ? false : "position"}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 380, damping: 36, mass: 0.5 }
              }
              className="min-w-0"
            >
              {b.node}
            </motion.div>
          ))}

          {live.map((b, i) => {
            const k = liveKey(b, i)
            return (
              <motion.div
                key={`l-${k}`}
                layout={reduce ? false : "position"}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 380, damping: 36, mass: 0.5 }
                }
                className="min-w-0"
              >
                <LiveBubbleView
                  b={b}
                  agent={agent}
                  onApprove={onApprove}
                  onReject={onReject}
                  onRetry={onRetry}
                />
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
              <ThinkingIndicator agent={agent} />
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </ScrollArea>

      <AnimatePresence>
        {!autoFollow && (
          <motion.div
            initial={reduce ? false : { opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8, y: 10 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 380, damping: 28 }
            }
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
  agent,
  onApprove,
  onReject,
  onRetry,
}: {
  b: LiveBubble
  agent?: AIAgent
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onRetry?: () => void
}) {
  if (b.kind === "user") return <UserBubble text={b.text} />
  if (b.kind === "assistant") {
    if (b.chunks.length === 0 && b.streaming) return null
    return <AssistantBubble chunks={b.chunks} streaming={b.streaming} agent={agent} />
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
  if (b.kind === "system_notice")
    return (
      <SystemNotice
        level={b.level}
        title={b.title}
        description={b.description}
        retryable={b.retryable}
        onRetry={onRetry}
      />
    )
  if (b.kind === "subagent")
    return (
      <SubAgentCard
        agent={b.agent}
        eventKind={b.eventKind}
        text={b.text}
        payload={b.payload}
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
    case "system_notice":
      return `n-${b.id}`
    case "subagent":
      return `s-${b.id}`
  }
}

// ---------- Persisted history rendering ----------

type RenderedBubble = { key: string; node: React.ReactNode }

function renderHistory(
  messages: AIMessage[],
  invocations: AIToolInvocation[],
  agent?: AIAgent,
): RenderedBubble[] {
  const out: RenderedBubble[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const text = parseContentText(m.content)
    if (m.role === "user") {
      out.push({ key: `u-${m.id}`, node: <UserBubble text={text} /> })
    } else if (m.role === "assistant") {
      if (text) {
        out.push({
          key: `a-${m.id}`,
          node: <AssistantBubble text={text} agent={agent} />,
        })
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
