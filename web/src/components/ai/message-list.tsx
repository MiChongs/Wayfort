"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ArrowDown, Sparkles } from "lucide-react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
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
import { BranchNav } from "./branch-nav"
import { cn } from "@/lib/utils"
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
  // Transient highlight for an in-conversation search hit (scroll-to + ring).
  highlightMsgId?: number | null
  // Branch DAG: parentId (0 = root) → sorted sibling message ids, for the
  // "‹2/3›" switcher on user messages that have sibling branches.
  branchSiblings?: Map<number, number[]>
  onSwitchBranch?: (siblingId: number) => void
}

export interface MessageListHandle {
  scrollToMessageId: (id: number) => void
  scrollToBottom: () => void
}

type GroupEntry = { __kind: "group"; name: string; groupKey: string; items: ToolLike[] }

// Everything the virtualized list's Header/Footer (rendered by Virtuoso) need.
// Passed via Virtuoso's `context` so the Header/Footer component identities stay
// stable (recreating them each render would remount + jank the scroller).
interface MLContext {
  onFooterRef: (el: HTMLDivElement | null) => void
  reduce: boolean
  liveGrouped: Array<LiveBubble | GroupEntry>
  thinking: boolean
  agent?: AIAgent
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onAnswer?: (id: string, text: string) => void
  onRetry?: () => void
  showSkeleton: boolean
  emptyState: boolean
  highlightMsgId?: number | null
}

const COLUMN = "mx-auto w-full min-w-0 max-w-3xl px-4 md:px-6"

export const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  {
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
    highlightMsgId,
    branchSiblings,
    onSwitchBranch,
  },
  ref,
) {
  const reduce = useReducedMotion()
  const virtuosoRef = React.useRef<VirtuosoHandle>(null)
  const scrollerElRef = React.useRef<HTMLElement | null>(null)
  const [autoFollow, setAutoFollow] = React.useState(true)
  // Read synchronously inside observers without waiting for a React re-render.
  const pinnedRef = React.useRef(true)

  // Live-turn (Footer) sticky-bottom: the Footer is NOT virtualized, so its
  // height grows as tokens stream. A ResizeObserver attached the moment the
  // Footer element mounts re-glues to the bottom on every growth while the user
  // is following — the same mechanic the non-virtual list used, scoped to the
  // footer. (History scroll-follow is handled by Virtuoso's followOutput.)
  const footerObsRef = React.useRef<ResizeObserver | null>(null)
  const onFooterRef = React.useCallback((el: HTMLDivElement | null) => {
    footerObsRef.current?.disconnect()
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      if (!pinnedRef.current) return
      const s = scrollerElRef.current
      if (s) s.scrollTop = s.scrollHeight
    })
    ro.observe(el)
    footerObsRef.current = ro
  }, [])
  React.useEffect(() => () => footerObsRef.current?.disconnect(), [])

  const historyBubbles = React.useMemo(
    () =>
      renderHistory(messages, invocations, agent, onRegenerateFrom, onEditUser, branchSiblings, onSwitchBranch),
    [messages, invocations, agent, onRegenerateFrom, onEditUser, branchSiblings, onSwitchBranch],
  )

  // msg.id → history index, for in-conversation search jump.
  const idToIndex = React.useMemo(() => {
    const m = new Map<number, number>()
    historyBubbles.forEach((b, i) => {
      if (b.msgId != null && !m.has(b.msgId)) m.set(b.msgId, i)
    })
    return m
  }, [historyBubbles])

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

  const showSkeleton = !!loading && historyBubbles.length === 0 && live.length === 0
  const emptyState =
    !showSkeleton &&
    historyBubbles.length === 0 &&
    live.length === 0 &&
    !running &&
    !thinking

  const scrollToBottomInstant = React.useCallback(() => {
    const s = scrollerElRef.current
    if (s) s.scrollTop = s.scrollHeight
  }, [])

  function jumpLatest() {
    pinnedRef.current = true
    setAutoFollow(true)
    const s = scrollerElRef.current
    if (s) s.scrollTo({ top: s.scrollHeight, behavior: "smooth" })
  }

  React.useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: scrollToBottomInstant,
      scrollToMessageId: (mid: number) => {
        const idx = idToIndex.get(mid)
        if (idx != null) {
          virtuosoRef.current?.scrollToIndex({ index: idx, align: "center", behavior: "smooth" })
        }
      },
    }),
    [idToIndex, scrollToBottomInstant],
  )

  const context = React.useMemo<MLContext>(
    () => ({
      onFooterRef,
      reduce: !!reduce,
      liveGrouped,
      thinking,
      agent,
      onApprove,
      onReject,
      onAnswer,
      onRetry,
      showSkeleton,
      emptyState,
      highlightMsgId,
    }),
    [
      onFooterRef,
      reduce,
      liveGrouped,
      thinking,
      agent,
      onApprove,
      onReject,
      onAnswer,
      onRetry,
      showSkeleton,
      emptyState,
      highlightMsgId,
    ],
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <Virtuoso<RenderedBubble, MLContext>
        ref={virtuosoRef}
        data={historyBubbles}
        context={context}
        computeItemKey={(_i, b) => `h-${b.key}`}
        itemContent={(_i, b) => (
          <div className={COLUMN}>
            <div
              className={cn(
                "min-w-0 rounded-lg py-3 transition-shadow",
                highlightMsgId != null &&
                  b.msgId === highlightMsgId &&
                  "ring-2 ring-primary/30",
              )}
            >
              {b.node}
            </div>
          </div>
        )}
        components={{ Header: MLHeader, Footer: MLFooter }}
        followOutput={(atBottom) => (atBottom ? "auto" : false)}
        atBottomThreshold={120}
        atBottomStateChange={(atBottom) => {
          pinnedRef.current = atBottom
          setAutoFollow((prev) => (prev === atBottom ? prev : atBottom))
        }}
        scrollerRef={(el) => {
          scrollerElRef.current = (el as HTMLElement) ?? null
        }}
        increaseViewportBy={{ top: 600, bottom: 1200 }}
        initialTopMostItemIndex={Math.max(0, historyBubbles.length - 1)}
        className="no-scrollbar h-full w-full"
      />

      <AnimatePresence>
        {!autoFollow && (
          <motion.div
            initial={reduce ? false : { opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8, y: 10 }}
            transition={
              reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 28 }
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
})

// Virtuoso Header: skeleton / empty state / agent intro + top breathing room.
function MLHeader({ context }: { context?: MLContext }) {
  if (!context) return <div className="h-6" />
  const { showSkeleton, emptyState, agent } = context
  return (
    <div className={cn(COLUMN, "pt-6")}>
      {showSkeleton && <MessageSkeleton />}
      {emptyState &&
        (agent ? (
          <AgentInfoCard agent={agent} />
        ) : (
          <EmptyState
            icon={Sparkles}
            title="开始一段对话"
            description="在下方输入指令，Agent 会按当前模式协助你；高危工具会请求你的确认。"
          />
        ))}
    </div>
  )
}

// Virtuoso Footer: the in-flight (live) turn. Non-virtualized so the streaming
// bubble stays mounted with stable identity for the whole turn — this is what
// keeps token streaming, the caret, and the live entrance animation intact.
function MLFooter({ context }: { context?: MLContext }) {
  if (!context) return null
  const { onFooterRef, liveGrouped, thinking, agent, reduce, onApprove, onReject, onAnswer, onRetry } =
    context
  const hasLive = liveGrouped.some(
    (e) =>
      isGroup(e) ||
      (e as LiveBubble).kind !== "assistant" ||
      (e as Extract<LiveBubble, { kind: "assistant" }>).chunks.length > 0,
  )
  return (
    <div ref={onFooterRef} className={cn(COLUMN, "space-y-6 pb-8 pt-3")}>
      <AnimatePresence initial={false}>
        {liveGrouped.map((entry, i) => {
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
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={
                reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 36, mass: 0.5 }
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
      {/* Keep the footer measurable even when empty so the ResizeObserver fires
          on the very first token. */}
      {!hasLive && !thinking && <div className="h-px" />}
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

function isGroup(e: LiveBubble | GroupEntry): e is GroupEntry {
  return (e as { __kind?: string }).__kind === "group"
}
function entryKey(e: LiveBubble | GroupEntry, i: number): string {
  if (isGroup(e)) return `g-${e.groupKey}`
  return liveKey(e, i)
}

// An assistant bubble "leads" a turn (and so shows the avatar) when the nearest
// rendered bubble before it is a user message — or there is none. Continuations
// after a tool / reasoning / group align under the gutter instead. Empty
// assistant placeholders are skipped so they never count as the predecessor.
function liveLead(entries: Array<LiveBubble | GroupEntry>, i: number): boolean {
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

type RenderedBubble = { key: string; node: React.ReactNode; msgId?: number }

function renderHistory(
  messages: AIMessage[],
  invocations: AIToolInvocation[],
  agent?: AIAgent,
  onRegenerateFrom?: (msg: AIMessage) => void,
  onEditUser?: (msg: AIMessage, newText: string) => void,
  branchSiblings?: Map<number, number[]>,
  onSwitchBranch?: (siblingId: number) => void,
): RenderedBubble[] {
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
            // update_plan drives the task panel, not a tool card — skip it in
            // the transcript (matches the live stream's skip).
            if (tc.name === "update_plan") continue
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

  const grouped = groupTools<HistoryItem>(
    flat,
    (it) => it.kind === "tool",
    (it) => (it as Extract<HistoryItem, { kind: "tool" }>).tool,
  )

  const out: RenderedBubble[] = []
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
      const sibs = branchSiblings?.get(it.msg.parent_id ?? 0)
      const hasBranches = !!sibs && sibs.length > 1 && sibs.includes(it.msg.id)
      const bubble = (
        <UserBubble
          text={it.text}
          images={parseContentImages(it.msg.content)}
          message={it.msg}
          onEdit={onEditUser}
        />
      )
      out.push({
        key: `u-${it.msg.id}`,
        msgId: it.msg.id,
        node: hasBranches ? (
          <div className="space-y-1">
            <div className="flex justify-end">
              <BranchNav
                index={sibs!.indexOf(it.msg.id)}
                total={sibs!.length}
                onPrev={() => {
                  const i = sibs!.indexOf(it.msg.id)
                  onSwitchBranch?.(sibs![(i - 1 + sibs!.length) % sibs!.length])
                }}
                onNext={() => {
                  const i = sibs!.indexOf(it.msg.id)
                  onSwitchBranch?.(sibs![(i + 1) % sibs!.length])
                }}
              />
            </div>
            {bubble}
          </div>
        ) : (
          bubble
        ),
      })
      prevKind = "user"
    } else if (it.kind === "assistant") {
      const lead = prevKind === undefined || prevKind === "user"
      out.push({
        key: `a-${it.msg.id}`,
        msgId: it.msg.id,
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
        msgId: it.tool.msgId,
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
