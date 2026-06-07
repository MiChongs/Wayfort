"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ArrowDown, Sparkles } from "lucide-react"
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
import { AskUserCard } from "./ask-user-card"
import { PlanCard } from "./plan-card"
import { groupTools, type ToolLike } from "@/lib/ai/group-tools"
import type { AIAgent, AIMessage, AIToolInvocation } from "@/lib/api/types"

export type LiveBubble =
  | { kind: "user"; id: string; text: string; images?: string[] }
  | { kind: "assistant"; id: string; chunks: string[]; streaming: boolean }
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
  | {
      kind: "ask"
      invocationId: string
      question: string
      options: { label: string; description?: string }[]
      allowMultiple: boolean
      allowText: boolean
    }
  | { kind: "plan"; invocationId: string; plan: string }

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
  onAnswer?: (id: string, text: string) => void
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
  onAnswer,
  onRetry,
  onRegenerateFrom,
  onEditUser,
}: MessageListProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const reduce = useReducedMotion()
  const [autoFollow, setAutoFollow] = React.useState(true)
  // Mirror of `autoFollow` we can read synchronously inside observers/handlers
  // without waiting for a React re-render — prevents the pin loop from lagging
  // a frame behind the user's scroll.
  const pinnedRef = React.useRef(true)

  const pin = React.useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    else el.scrollTop = el.scrollHeight
  }, [])

  // Bottom-pinning. A one-shot effect keyed on `messages`/`live` lands BEFORE
  // the `layout` springs finish animating height and BEFORE the streamed-text
  // throttle paints, so it always falls short of the true bottom. Instead we
  // observe the content element's size: every time it grows (spring tick,
  // token arrival, image load) we re-glue to the bottom — but only while the
  // user is following. This is the same "stick to bottom" mechanic Claude.ai
  // uses and it stays smooth because the growth itself is gradual.
  React.useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) pin(false)
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [pin])

  // Track whether the user sits at the bottom; drives follow-state + the
  // floating "jump to latest" affordance. rAF-debounced so a burst of scroll
  // events (momentum / programmatic pin) collapses to one state update.
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const handle = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const atBottom =
          el.scrollHeight - el.scrollTop - el.clientHeight < 120
        pinnedRef.current = atBottom
        setAutoFollow((prev) => (prev === atBottom ? prev : atBottom))
      })
    }
    el.addEventListener("scroll", handle, { passive: true })
    return () => {
      el.removeEventListener("scroll", handle)
      cancelAnimationFrame(raf)
    }
  }, [])

  function jumpLatest() {
    pinnedRef.current = true
    setAutoFollow(true)
    pin(true)
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
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <ScrollArea
        viewportRef={scrollRef}
        className="min-h-0 w-full flex-1"
      >
        <div
          ref={contentRef}
          className="mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-8 md:px-6"
        >
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
            // History bubbles are the settled state — they must NOT replay an
            // entrance animation. Without `initial={false}` a message that just
            // finished streaming (live key `l-…`) re-mounts as history (key
            // `h-…`) and animates in a SECOND time. We keep only `layout` so
            // positions still ease when the list above changes.
            <motion.div
              key={`h-${b.key}`}
              layout={reduce ? false : "position"}
              initial={false}
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
            // Skip the eagerly-pushed empty assistant placeholders so they don't
            // occupy a (gap-producing) motion.div slot before any text arrives.
            if (
              !isGroup(entry) &&
              (entry as LiveBubble).kind === "assistant" &&
              (entry as Extract<LiveBubble, { kind: "assistant" }>).chunks.length === 0
            ) {
              return null
            }
            const key = entryKey(entry, i)
            return (
              <motion.div
                key={`l-${key}`}
                layout={reduce ? false : "position"}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                // Plain opacity exit: a live bubble that just settled is about to
                // re-mount as an identical history bubble. A scale/translate exit
                // would make that seamless handoff flicker — a quiet fade doesn't.
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
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
                    lead={liveLead(liveGrouped, i)}
                    agent={agent}
                    onApprove={onApprove}
                    onReject={onReject}
                    onAnswer={onAnswer}
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
            className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2"
          >
            <button
              type="button"
              onClick={jumpLatest}
              aria-label="返回最新"
              className="group flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-background/90 text-muted-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ArrowDown className="h-4 w-4 transition-transform group-hover:translate-y-0.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function LiveBubbleView({
  b,
  lead = true,
  agent,
  onApprove,
  onReject,
  onAnswer,
  onRetry,
}: {
  b: LiveBubble
  lead?: boolean
  agent?: AIAgent
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onAnswer?: (id: string, text: string) => void
  onRetry?: () => void
}) {
  if (b.kind === "user") return <UserBubble text={b.text} images={b.images} />
  if (b.kind === "assistant") {
    // Hide totally empty assistant bubbles (we eagerly push one after every
    // tool_output to anticipate the continuation; if none arrives we don't
    // want a blank card sitting there).
    if (b.chunks.length === 0) return null
    return (
      <AssistantBubble chunks={b.chunks} streaming={b.streaming} agent={agent} lead={lead} />
    )
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
      <ReasoningBlock state="thinking" chunks={b.chunks} lead={lead} agent={agent} />
    ) : (
      <ReasoningBlock
        state="thought"
        chunks={b.chunks}
        durationSec={seconds}
        lead={lead}
        agent={agent}
      />
    )
  }
  if (b.kind === "ask")
    return (
      <AskUserCard
        question={b.question}
        options={b.options}
        allowMultiple={b.allowMultiple}
        allowText={b.allowText}
        onSubmit={(text) => onAnswer?.(b.invocationId, text)}
      />
    )
  if (b.kind === "plan")
    return (
      <PlanCard
        plan={b.plan}
        onApprove={() => onApprove(b.invocationId)}
        onReject={() => onReject(b.invocationId)}
      />
    )
  return null
}

function liveKey(b: LiveBubble, _i: number): string {
  switch (b.kind) {
    case "user":
      return `u-${b.id}`
    case "assistant":
      return `a-${b.id}`
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
    case "ask":
      return `ask-${b.invocationId}`
    case "plan":
      return `plan-${b.invocationId}`
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

// An assistant bubble "leads" a turn (and so shows the avatar) when the nearest
// rendered bubble before it is a user message — or there is none. Continuations
// after a tool / reasoning / group align under the gutter instead. Empty
// assistant placeholders are skipped so they never count as the predecessor.
function liveLead(
  entries: Array<
    LiveBubble | { __kind: "group"; name: string; groupKey: string; items: ToolLike[] }
  >,
  i: number,
): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const e = entries[k]
    if (isGroup(e)) return false
    const b = e as LiveBubble
    if (b.kind === "assistant" && b.chunks.length === 0) continue // skipped placeholder
    return b.kind === "user"
  }
  return true
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
            // Correlate by the exact tool_call id (a tool called N times in one
            // turn has N distinct ids). Fall back to message_id + name for
            // rows persisted before tool_call_id existed.
            const inv =
              invocations.find((iv) => iv.tool_call_id && iv.tool_call_id === tc.id) ??
              invocations.find((iv) => iv.message_id === m.id && iv.tool_name === tc.name)
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
  // Track the previously emitted bubble kind so an assistant block can tell
  // whether it leads a turn (avatar) or continues one (gutter spacer).
  let prevKind: "user" | "assistant" | "tool" | undefined
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
      prevKind = "tool"
      continue
    }
    const it = entry as HistoryItem
    if (it.kind === "user") {
      out.push({
        key: `u-${it.msg.id}`,
        node: (
          <UserBubble
            text={it.text}
            images={parseContentImages(it.msg.content)}
            message={it.msg}
            onEdit={onEditUser}
          />
        ),
      })
      prevKind = "user"
    } else if (it.kind === "assistant") {
      const lead = prevKind === undefined || prevKind === "user"
      out.push({
        key: `a-${it.msg.id}`,
        node: (
          <AssistantBubble
            text={it.text}
            agent={agent}
            message={it.msg}
            onRegenerateFrom={onRegenerateFrom}
            lead={lead}
          />
        ),
      })
      prevKind = "assistant"
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
      prevKind = "tool"
    }
  }
  return out
}

function parseContentText(s: string): string {
  try {
    const parts = JSON.parse(s) as { type?: string; text?: string }[]
    return parts
      .filter((p) => p.type === "text" || p.type === undefined)
      .map((p) => p.text || "")
      .join("")
  } catch {
    return s || ""
  }
}

function parseContentImages(s: string): string[] {
  try {
    const parts = JSON.parse(s) as { type?: string; image_url?: string }[]
    return parts
      .filter((p) => (p.type === "image_url" || p.type === "image") && !!p.image_url)
      .map((p) => p.image_url as string)
  } catch {
    return []
  }
}
