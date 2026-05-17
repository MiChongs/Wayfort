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
import { ReasoningBlock } from "./reasoning-block"
import { ToolGroupCard } from "./tool-group-card"
import { AgentInfoCard } from "./agent-info-card"
import { groupTools, type ToolLike } from "@/lib/ai/group-tools"
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
  | {
      kind: "reasoning"
      id: string
      chunks: string[]
      streaming: boolean
      startedAt: number
      endedAt?: number
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
  onRegenerateFrom?: (msg: AIMessage) => void
  onEditUser?: (msg: AIMessage, newText: string) => void
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
  onRegenerateFrom,
  onEditUser,
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
    () => renderHistory(messages, invocations, agent, onRegenerateFrom, onEditUser),
    [messages, invocations, agent, onRegenerateFrom, onEditUser],
  )

  // Group consecutive ≥3 same-name tools in the live stream for visual density.
  const liveGrouped = React.useMemo(
    () =>
      groupTools<LiveBubble>(
        live,
        (b) => b.kind === "tool",
        (b) => {
          const t = b as Extract<LiveBubble, { kind: "tool" }>
          return {
            id: t.id,
            name: t.name,
            status: t.status,
            output: t.output,
            error: t.error,
            danger: t.danger,
          } as ToolLike
        },
      ),
    [live],
  )

  const showSkeleton = loading && historyBubbles.length === 0 && live.length === 0
  const emptyState =
    !showSkeleton &&
    historyBubbles.length === 0 &&
    live.length === 0 &&
    !running &&
    !thinking

  return (
    // Natural flex column instead of absolute-positioned ScrollArea. The
    // wrapper keeps `relative` only so the floating "jump-to-latest" button
    // can position over it; everything else is plain flex so Radix's
    // Viewport gets a fully-determined height and its internal scroll
    // engages reliably.
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden bg-muted/20">
      <ScrollArea
        viewportRef={scrollRef}
        className="flex-1 min-h-0 w-full"
      >
        <div className="px-3 md:px-6 py-6 space-y-4 min-w-0">
        {showSkeleton && <MessageSkeleton />}

        {emptyState && (
          <div className="py-8 max-w-3xl mx-auto w-full space-y-4">
            {agent ? (
              <AgentInfoCard agent={agent} />
            ) : (
              <EmptyState
                icon={Sparkles}
                title="开始一段对话"
                description="在下方输入指令，Agent 会按当前模式协助你；高危工具会请求你的确认。"
              />
            )}
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

          {liveGrouped.map((entry, i) => {
            const key = entryKey(entry, i)
            return (
              <motion.div
                key={`l-${key}`}
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
                {isGroup(entry) ? (
                  <ToolGroupCard name={entry.name} items={entry.items} />
                ) : (
                  <LiveBubbleView
                    b={entry as LiveBubble}
                    agent={agent}
                    onApprove={onApprove}
                    onReject={onReject}
                    onRetry={onRetry}
                  />
                )}
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
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10"
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
    // Hide totally empty assistant bubbles (we eagerly push one after every
    // tool_output to anticipate the continuation; if none arrives we don't
    // want a blank card sitting there).
    if (b.chunks.length === 0) return null
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
  if (b.kind === "reasoning") {
    const seconds = Math.max(
      0,
      Math.round(((b.endedAt ?? Date.now()) - b.startedAt) / 1000),
    )
    return b.streaming ? (
      <ReasoningBlock state="thinking" chunks={b.chunks} />
    ) : (
      <ReasoningBlock state="thought" chunks={b.chunks} durationSec={seconds} />
    )
  }
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
    case "reasoning":
      return `r-${b.id}`
  }
}

// `groupTools` returns either a passthrough LiveBubble or a synthetic group.
// Helpers to discriminate + key.
function isGroup(
  e: LiveBubble | { __kind: "group"; name: string; groupKey: string; items: ToolLike[] },
): e is { __kind: "group"; name: string; groupKey: string; items: ToolLike[] } {
  return (e as { __kind?: string }).__kind === "group"
}
function entryKey(
  e: LiveBubble | { __kind: "group"; name: string; groupKey: string; items: ToolLike[] },
  i: number,
): string {
  if (isGroup(e)) return `g-${e.groupKey}`
  return liveKey(e, i)
}

// ---------- Persisted history rendering ----------

type RenderedBubble = { key: string; node: React.ReactNode }

function renderHistory(
  messages: AIMessage[],
  invocations: AIToolInvocation[],
  agent?: AIAgent,
  onRegenerateFrom?: (msg: AIMessage) => void,
  onEditUser?: (msg: AIMessage, newText: string) => void,
): RenderedBubble[] {
  // First pass: build flat list of either AIMessage-derived ToolLike entries
  // (with tool meta) or other bubbles, so groupTools can fold runs.
  type HistoryItem =
    | { kind: "user"; msg: AIMessage; text: string }
    | { kind: "assistant"; msg: AIMessage; text: string }
    | {
        kind: "tool"
        key: string
        tool: ToolLike & { msgId: number; callId: string }
      }
  const flat: HistoryItem[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const text = parseContentText(m.content)
    if (m.role === "user") {
      flat.push({ kind: "user", msg: m, text })
    } else if (m.role === "assistant") {
      if (text) flat.push({ kind: "assistant", msg: m, text })
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
            flat.push({
              kind: "tool",
              key: `t-${m.id}-${tc.id}`,
              tool: {
                id: tc.id,
                name: tc.name,
                status,
                output: result || inv?.output,
                error: inv?.error,
                danger: isDangerName(tc.name),
                msgId: m.id,
                callId: tc.id,
              },
            })
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Second pass: group runs of ≥3 consecutive tools with the same name.
  const grouped = groupTools<HistoryItem>(
    flat,
    (it) => it.kind === "tool",
    (it) => (it as Extract<HistoryItem, { kind: "tool" }>).tool,
  )

  const out: RenderedBubble[] = []
  for (const entry of grouped) {
    if ((entry as { __kind?: string }).__kind === "group") {
      const g = entry as {
        __kind: "group"
        name: string
        groupKey: string
        items: ToolLike[]
      }
      out.push({
        key: `tg-${g.groupKey}`,
        node: <ToolGroupCard name={g.name} items={g.items} />,
      })
      continue
    }
    const it = entry as HistoryItem
    if (it.kind === "user") {
      out.push({
        key: `u-${it.msg.id}`,
        node: (
          <UserBubble
            text={it.text}
            message={it.msg}
            onEdit={onEditUser}
          />
        ),
      })
    } else if (it.kind === "assistant") {
      out.push({
        key: `a-${it.msg.id}`,
        node: (
          <AssistantBubble
            text={it.text}
            agent={agent}
            message={it.msg}
            onRegenerateFrom={onRegenerateFrom}
          />
        ),
      })
    } else {
      out.push({
        key: it.key,
        node: (
          <ToolCard
            name={it.tool.name}
            status={it.tool.status}
            output={it.tool.output}
            error={it.tool.error}
            danger={it.tool.danger}
            defaultExpanded={false}
          />
        ),
      })
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
