"use client"

import * as React from "react"
import { use } from "react"
import { motion } from "motion/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, SearchX } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { aiAgentService, aiConversationService, aiProviderService } from "@/lib/api/services"
import { streamSSE } from "@/lib/sse/eventsource"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { ConversationHeader } from "@/components/ai/conversation-header"
import { Composer } from "@/components/ai/composer"
import { MessageList, type LiveBubble, type MessageListHandle } from "@/components/ai/message-list"
import { InvocationTimeline } from "@/components/ai/invocation-timeline"
import { TaskPanel } from "@/components/ai/task-panel"
import { ConversationSearch } from "@/components/ai/conversation-search"
import { isDangerName } from "@/components/ai/tool-icons"
import { useMediaQuery } from "@/lib/hooks/use-media-query"
import { EMPTY_PLAN, mergePlanUpdate, type AgentPlan, type AgentTask } from "@/lib/ai/plan"
import type { PermissionMode } from "@/lib/api/types"

type StreamEvent =
  | { kind: "message_start"; conversation_id?: string; message_id?: string }
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; id: string; name: string; arguments?: string }
  | { kind: "tool_start"; id: string; invocation_id: string }
  | {
      kind: "tool_output"
      id: string
      output: string
      dry_run?: boolean
      truncated?: boolean
    }
  | { kind: "tool_output_delta"; id: string; delta: string }
  | { kind: "tool_error"; id: string; error: string }
  | {
      kind: "permission_required"
      invocation_id: string
      tool: string
      summary: string
    }
  | { kind: "usage"; input_tokens: number; output_tokens: number }
  | { kind: "message_end"; finish_reason: string }
  | { kind: "error"; error: string }
  | {
      kind: "subagent_event"
      agent: string
      kind_inner?: string
      text?: string
      [k: string]: unknown
    }
  | { kind: "reasoning_start" }
  | { kind: "reasoning_delta"; text: string }
  | { kind: "reasoning_end" }
  | {
      kind: "ask_user"
      invocation_id: string
      id?: string
      question: string
      options?: { label: string; description?: string }[]
      allow_multiple?: boolean
      allow_text?: boolean
    }
  | { kind: "plan_presented"; invocation_id: string; id?: string; plan: string }
  | {
      kind: "plan_update"
      conversation_id?: string
      tasks: AgentTask[]
      summary?: { total: number; done: number; active: number }
    }
  | { kind: "title_update"; conversation_id?: string; title: string }
  | { kind: "done" }
  | { kind: "ping" }

const FINISH_REASON_NOTICES: Record<
  string,
  { level: "info" | "warning"; title: string; description?: string; retryable?: boolean }
> = {
  length: {
    level: "warning",
    title: "输出已被模型截断",
    description: "达到模型的 max_tokens 上限；可重新发送让 Agent 继续。",
    retryable: true,
  },
  content_filter: {
    level: "warning",
    title: "内容被模型过滤",
    description: "提供商安全策略拦截了部分内容。",
  },
  max_iterations: {
    level: "warning",
    title: "已达到最大工具调用轮次",
    description: "本轮 Agent 调用次数已达 max_iterations 上限。",
    retryable: true,
  },
  tool_call_limit: {
    level: "warning",
    title: "工具调用次数超限",
    retryable: true,
  },
}

export default function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const qc = useQueryClient()
  const router = useRouter()

  const detail = useQuery({
    queryKey: ["ai", "conv", id],
    queryFn: () => aiConversationService.get(id),
  })
  const agentsQuery = useQuery({
    queryKey: ["ai", "agents"],
    queryFn: aiAgentService.list,
  })
  // Branch points → "‹2/3›" switchers on user messages that have siblings.
  const branchesQuery = useQuery({
    queryKey: ["ai", "branches", id],
    queryFn: () => aiConversationService.branches(id),
  })
  const branchSiblings = React.useMemo(() => {
    const m = new Map<number, number[]>()
    for (const g of branchesQuery.data?.branches || []) {
      m.set(g.parent_id, [...g.siblings].sort((a, b) => a - b))
    }
    return m
  }, [branchesQuery.data])
  const switchBranch = React.useCallback(
    async (siblingId: number) => {
      try {
        await aiConversationService.setActiveLeaf(id, siblingId)
        qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
        qc.invalidateQueries({ queryKey: ["ai", "branches", id] })
      } catch (e: unknown) {
        toast.error("切换分支失败", { description: (e as Error).message })
      }
    },
    [id, qc],
  )
  const agent = React.useMemo(() => {
    const aid = detail.data?.conversation.agent_id
    if (!aid) return undefined
    return agentsQuery.data?.agents.find((a) => a.id === aid)
  }, [detail.data, agentsQuery.data])

  // Current model's vision capability — gates the composer's image-attach
  // affordance. Undefined (provider/model unknown) falls through to "allowed".
  const providerId = detail.data?.conversation.provider_id
  const modelName = detail.data?.conversation.model
  const modelsQuery = useQuery({
    queryKey: ["ai", "provider-models", providerId],
    queryFn: () => aiProviderService.models(providerId as number),
    enabled: !!providerId,
    staleTime: 10 * 60 * 1000,
  })
  const modelVision = React.useMemo<boolean | undefined>(() => {
    const list = modelsQuery.data?.models
    if (!list || !modelName) return undefined
    const m = list.find((x) => x.id === modelName)
    return m ? !!m.vision : undefined
  }, [modelsQuery.data, modelName])

  const [draft, setDraft] = React.useState("")
  const [attachments, setAttachments] = React.useState<string[]>([])
  const [live, setLive] = React.useState<LiveBubble[]>([])
  const [plan, setPlan] = React.useState<AgentPlan>(EMPTY_PLAN)
  const [planCollapsed, setPlanCollapsed] = React.useState(false)
  const isDesktop = useMediaQuery("(min-width: 1024px)")
  const [running, setRunning] = React.useState(false)
  const [thinking, setThinking] = React.useState(false)
  const [usageIn, setUsageIn] = React.useState(0)
  const [usageOut, setUsageOut] = React.useState(0)
  const abortRef = React.useRef<AbortController | null>(null)
  const noticeSeqRef = React.useRef(0)
  const lastEventAtRef = React.useRef<number>(0)
  const [tab, setTab] = React.useState<"chat" | "invocations">("chat")
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null)
  const messageListRef = React.useRef<MessageListHandle | null>(null)
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [highlightMsgId, setHighlightMsgId] = React.useState<number | null>(null)
  const highlightTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const jumpToMessage = React.useCallback((mid: number) => {
    messageListRef.current?.scrollToMessageId(mid)
    setHighlightMsgId(mid)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => setHighlightMsgId(null), 1600)
  }, [])

  // Monotonic id for live user/assistant bubbles. Stable identity is what lets
  // React keep a streaming bubble mounted as the list above it changes (tools
  // fold into groups, notices append). Index-based keys would shift and remount
  // the bubble mid-stream — resetting its text and replaying the entrance anim.
  const liveIdRef = React.useRef(0)
  const mkLiveId = React.useCallback(() => {
    liveIdRef.current += 1
    return `lb-${liveIdRef.current}`
  }, [])

  // Pre-fill the composer from a `?draft=` query param — the home page's
  // suggestions / quick-start carry the user's first message here so a new
  // conversation opens ready to send (Claude-web style). Consume once and
  // strip the param so a refresh doesn't re-fill it.
  const searchParams = useSearchParams()
  const draftConsumedRef = React.useRef(false)
  React.useEffect(() => {
    if (draftConsumedRef.current) return
    const q = searchParams.get("draft")
    if (q) {
      draftConsumedRef.current = true
      setDraft(q)
      router.replace(`/ai/conversations/${id}` as Parameters<typeof router.replace>[0])
      setTimeout(() => composerRef.current?.focus(), 120)
    }
  }, [searchParams, id, router])

  function nextNoticeId(): string {
    noticeSeqRef.current += 1
    return `n-${Date.now()}-${noticeSeqRef.current}`
  }

  function pushNotice(
    level: "info" | "warning" | "error",
    title: string,
    description?: string,
    retryable?: boolean,
    dedupeTitle?: string,
  ) {
    setLive((l) => {
      if (dedupeTitle && l.some((b) => b.kind === "system_notice" && b.title === dedupeTitle)) {
        return l
      }
      return [
        ...l,
        {
          kind: "system_notice",
          id: nextNoticeId(),
          level,
          title,
          description,
          retryable,
        },
      ]
    })
  }

  const changeMode = useMutation({
    mutationFn: (mode: PermissionMode) =>
      aiConversationService.update(id, { permission_mode: mode }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      toast.success("已切换权限模式")
    },
  })

  const renameConv = useMutation({
    mutationFn: (title: string) => aiConversationService.update(id, { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      toast.success("已重命名")
    },
  })

  const removeConv = useMutation({
    mutationFn: () => aiConversationService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      toast.success("已删除对话")
      router.push("/ai")
    },
  })

  async function handleSlash(cmd: string): Promise<boolean> {
    const c = cmd.trim().toLowerCase()
    if (!c.startsWith("/")) return false
    if (c === "/clear") {
      const ok = await confirmDialog({
        title: "清空当前对话？",
        description: "所有消息和工具调用都会被删除。",
        destructive: true,
      })
      if (ok) removeConv.mutate()
      return true
    }
    if (c === "/plan" || c === "/normal" || c === "/bypass") {
      changeMode.mutate(c.slice(1) as PermissionMode)
      return true
    }
    if (c === "/cancel") {
      cancel()
      return true
    }
    return false
  }

  // Text deltas can fire 30-60 events/sec. We coalesce them into one setLive
  // per animation frame so React doesn't re-render the whole message tree on
  // every byte. Other events (tool_call, tool_output, etc.) flush immediately
  // because they're rare and individually meaningful.
  const pendingTextRef = React.useRef("")
  const flushScheduledRef = React.useRef(false)
  const flushText = React.useCallback(() => {
    flushScheduledRef.current = false
    const buffered = pendingTextRef.current
    if (!buffered) return
    pendingTextRef.current = ""
    setLive((l) => {
      const next = l.slice()
      const last = next[next.length - 1]
      if (last && last.kind === "assistant") {
        next[next.length - 1] = {
          ...last,
          chunks: [...last.chunks, buffered],
          streaming: true,
        }
      } else {
        next.push({
          kind: "assistant",
          id: mkLiveId(),
          chunks: [buffered],
          streaming: true,
        })
      }
      return next
    })
  }, [mkLiveId])

  // Same RAF-batch pattern for reasoning deltas (which can come at OpenAI
  // o-series / Claude extended-thinking rates too). We append to the latest
  // open reasoning bubble (one with streaming=true).
  const pendingReasoningRef = React.useRef("")
  const reasoningFlushScheduledRef = React.useRef(false)
  const reasoningSeqRef = React.useRef(0)
  const flushReasoning = React.useCallback(() => {
    reasoningFlushScheduledRef.current = false
    const buffered = pendingReasoningRef.current
    if (!buffered) return
    pendingReasoningRef.current = ""
    setLive((l) => {
      const next = l.slice()
      // Look for the latest streaming reasoning bubble.
      for (let i = next.length - 1; i >= 0; i--) {
        const b = next[i]
        if (b.kind === "reasoning" && b.streaming) {
          next[i] = { ...b, chunks: [...b.chunks, buffered] }
          return next
        }
      }
      // No open reasoning bubble: open one (defensive — usually reasoning_start
      // already created it).
      reasoningSeqRef.current += 1
      next.push({
        kind: "reasoning",
        id: `rs-${Date.now()}-${reasoningSeqRef.current}`,
        chunks: [buffered],
        streaming: true,
        startedAt: Date.now(),
      })
      return next
    })
  }, [])

  function dispatchEvent(ev: StreamEvent) {
    // Stop the "thinking / requesting" indicator only once real content
    // arrives. NB: message_start is emitted by the backend immediately at the
    // top of the turn (before any tokens), so it must NOT clear thinking —
    // otherwise the indicator vanishes during the whole request-latency gap.
    if (
      ev.kind === "text_delta" ||
      ev.kind === "tool_call" ||
      ev.kind === "tool_output" ||
      ev.kind === "permission_required" ||
      ev.kind === "ask_user" ||
      ev.kind === "plan_presented" ||
      ev.kind === "plan_update"
    ) {
      setThinking(false)
    }
    if (ev.kind !== "ping") lastEventAtRef.current = Date.now()

    switch (ev.kind) {
      case "reasoning_start":
        setThinking(false)
        reasoningSeqRef.current += 1
        setLive((l) => [
          ...l,
          {
            kind: "reasoning",
            id: `rs-${Date.now()}-${reasoningSeqRef.current}`,
            chunks: [],
            streaming: true,
            startedAt: Date.now(),
          },
        ])
        return
      case "reasoning_delta":
        setThinking(false)
        pendingReasoningRef.current += ev.text
        if (!reasoningFlushScheduledRef.current) {
          reasoningFlushScheduledRef.current = true
          requestAnimationFrame(flushReasoning)
        }
        return
      case "reasoning_end":
        // Flush any pending text first so order on screen matches the wire.
        if (pendingReasoningRef.current) flushReasoning()
        setLive((l) => {
          const next = l.slice()
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i]
            if (b.kind === "reasoning" && b.streaming) {
              next[i] = { ...b, streaming: false, endedAt: Date.now() }
              break
            }
          }
          return next
        })
        return
      case "plan_update":
        // The live task panel is driven entirely by these full-array updates
        // (separate from the bubble list, so handle it here and return).
        setThinking(false)
        setPlan(mergePlanUpdate(ev.tasks || []))
        return
      case "title_update": {
        type ConvDetail = Awaited<ReturnType<typeof aiConversationService.get>>
        qc.setQueryData<ConvDetail>(["ai", "conv", id], (old) =>
          old ? { ...old, conversation: { ...old.conversation, title: ev.title } } : old,
        )
        qc.invalidateQueries({ queryKey: ["ai", "convs"] })
        return
      }
      case "message_start":
      case "ping":
        return
      case "done":
        // Mark trailing assistant as no-longer-streaming. Finally-block also
        // does this, but `done` is the explicit signal.
        setLive((l) => {
          if (l.length === 0) return l
          const next = l.slice()
          const last = next[next.length - 1]
          if (last && last.kind === "assistant" && last.streaming) {
            next[next.length - 1] = { ...last, streaming: false }
          }
          return next
        })
        return
      case "message_end": {
        const reason = ev.finish_reason || "stop"
        const map = FINISH_REASON_NOTICES[reason]
        if (map) {
          pushNotice(map.level, map.title, map.description, map.retryable)
        } else if (reason && reason !== "stop") {
          pushNotice(
            "info",
            "本轮结束",
            `finish_reason: ${reason}`,
            false,
          )
        }
        return
      }
      case "error":
        pushNotice("error", "生成失败", ev.error, true)
        return
      case "usage":
        setUsageIn((v) => v + ev.input_tokens)
        setUsageOut((v) => v + ev.output_tokens)
        return
      case "subagent_event":
        setLive((l) => [
          ...l,
          {
            kind: "subagent",
            id: `sa-${Date.now()}-${l.length}`,
            agent: ev.agent,
            eventKind:
              typeof ev.kind_inner === "string"
                ? ev.kind_inner
                : (ev as { type?: string }).type,
            text: ev.text,
            payload: tryStringify({ ...ev, agent: undefined, kind: undefined }),
          },
        ])
        return
    }

    if (ev.kind === "text_delta") {
      // If any reasoning bubble is still open, close it now — the main
      // response has started, so the "thinking" card should auto-collapse
      // into its "已思考 Xs" form.
      setLive((l) => {
        let changed = false
        const next = l.slice()
        for (let i = next.length - 1; i >= 0; i--) {
          const b = next[i]
          if (b.kind === "reasoning" && b.streaming) {
            next[i] = { ...b, streaming: false, endedAt: Date.now() }
            changed = true
            break
          }
        }
        return changed ? next : l
      })
      // Buffer + RAF flush — see flushText above.
      pendingTextRef.current += ev.text
      if (!flushScheduledRef.current) {
        flushScheduledRef.current = true
        requestAnimationFrame(flushText)
      }
      return
    }

    // Flush any buffered text/reasoning before structural changes so the order
    // on screen matches the order on the wire (text → tool_call, not the
    // other way around).
    if (pendingTextRef.current) {
      flushText()
    }
    if (pendingReasoningRef.current) {
      flushReasoning()
    }

    setLive((l) => {
      const next = l.slice()
      switch (ev.kind) {
        case "tool_call":
          // ask_user / exit_plan_mode are interaction primitives, and
          // update_plan drives the task panel — none get a generic tool bubble.
          if (ev.name === "ask_user" || ev.name === "exit_plan_mode" || ev.name === "update_plan") break
          next.push({
            kind: "tool",
            id: ev.id,
            name: ev.name,
            status: "pending",
            danger: isDangerName(ev.name),
          })
          break
        case "permission_required":
          next.push({
            kind: "permission",
            invocationId: ev.invocation_id,
            tool: ev.tool,
            summary: ev.summary,
            danger: isDangerName(ev.tool),
          })
          break
        case "ask_user":
          next.push({
            kind: "ask",
            invocationId: ev.invocation_id,
            question: ev.question,
            options: ev.options || [],
            allowMultiple: !!ev.allow_multiple,
            allowText: ev.allow_text !== false && (ev.allow_text === true || !(ev.options && ev.options.length)),
          })
          break
        case "plan_presented":
          next.push({
            kind: "plan",
            invocationId: ev.invocation_id,
            plan: ev.plan,
          })
          break
        case "tool_start": {
          const idx = next.findIndex(
            (x) => x.kind === "tool" && x.id === ev.id,
          )
          if (idx >= 0) {
            const t = next[idx] as Extract<LiveBubble, { kind: "tool" }>
            next[idx] = {
              ...t,
              status: "running",
              invocationId: ev.invocation_id,
            }
          }
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i]
            if (
              b.kind === "permission" &&
              b.invocationId === ev.invocation_id
            ) {
              next.splice(i, 1)
              break
            }
          }
          break
        }
        case "tool_output_delta": {
          // Live output: append the fragment to the tool bubble (capped so a
          // chatty command can't grow the DOM unbounded; the final tool_output
          // replaces it with the authoritative, truncated result).
          const idx = next.findIndex((x) => x.kind === "tool" && x.id === ev.id)
          if (idx >= 0) {
            const t = next[idx] as Extract<LiveBubble, { kind: "tool" }>
            const grown = (t.output || "") + ev.delta
            next[idx] = {
              ...t,
              status: t.status === "pending" ? "running" : t.status,
              output: grown.length > 9000 ? grown.slice(grown.length - 9000) : grown,
            }
          }
          break
        }
        case "tool_output": {
          const idx = next.findIndex(
            (x) => x.kind === "tool" && x.id === ev.id,
          )
          if (idx >= 0) {
            const t = next[idx] as Extract<LiveBubble, { kind: "tool" }>
            next[idx] = {
              ...t,
              status: ev.dry_run ? "dry_run" : "output",
              output: ev.output,
            }
          }
          // Begin a fresh assistant bubble for the continuation after the tool result.
          next.push({ kind: "assistant", id: mkLiveId(), chunks: [], streaming: true })
          break
        }
        case "tool_error": {
          const idx = next.findIndex(
            (x) => x.kind === "tool" && x.id === ev.id,
          )
          if (idx >= 0) {
            const t = next[idx] as Extract<LiveBubble, { kind: "tool" }>
            next[idx] = { ...t, status: "error", error: ev.error }
          }
          break
        }
      }
      return next
    })
  }

  // streamRun is the shared SSE-turn driver: it optimistically pushes the live
  // bubbles, opens the stream at `path`, dispatches events, and finalizes. send
  // (append), regenerate (/regenerate), and edit-to-branch (/messages/:id/branch)
  // all flow through it.
  async function streamRun(opts: {
    path: string
    body: Record<string, unknown>
    userBubble?: { text: string; images?: string[] }
  }) {
    if (running) return
    setLive((l) => [
      ...l,
      ...(opts.userBubble
        ? [
            {
              kind: "user",
              id: mkLiveId(),
              text: opts.userBubble.text,
              images: opts.userBubble.images?.length ? opts.userBubble.images : undefined,
            } as LiveBubble,
          ]
        : []),
      { kind: "assistant", id: mkLiveId(), chunks: [], streaming: true } as LiveBubble,
    ])
    setRunning(true)
    setThinking(true)
    setUsageIn(0)
    setUsageOut(0)
    lastEventAtRef.current = Date.now()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await streamSSE(
        `/api/proxy/api/v1/ai/conversations/${id}${opts.path}`,
        { method: "POST", body: opts.body, signal: ctrl.signal },
        (kind, data) => {
          const ev = { kind, ...(data as object) } as StreamEvent
          dispatchEvent(ev)
        },
      )
    } catch (e: unknown) {
      if (ctrl.signal.aborted) {
        pushNotice("info", "已中止生成", "用户取消了本轮回复，可点重新发送上一条消息。", true)
      } else {
        pushNotice("error", "连接失败", (e as Error).message, true)
      }
    } finally {
      setRunning(false)
      setThinking(false)
      if (pendingTextRef.current) flushText()
      if (pendingReasoningRef.current) flushReasoning()
      setLive((l) => {
        if (l.length === 0) return l
        const next = l.slice()
        for (let i = next.length - 1; i >= 0; i--) {
          const b = next[i]
          if (b.kind === "assistant" && b.streaming) {
            next[i] = { ...b, streaming: false }
          } else if (b.kind === "reasoning" && b.streaming) {
            next[i] = { ...b, streaming: false, endedAt: Date.now() }
          }
        }
        return next
      })
      // The server is now the source of truth — clear the live overlay once the
      // post-run refetch lands (handles regenerate/branch where message_count
      // may not strictly grow).
      pendingClearRef.current = true
      qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      qc.invalidateQueries({ queryKey: ["ai", "branches", id] })
    }
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? draft).trim()
    // Images ride along only on a fresh draft send (retry re-sends text only).
    const images = textOverride ? [] : attachments
    if ((!text && images.length === 0) || running) return
    setDraft("")
    if (!textOverride) setAttachments([])
    if (await handleSlash(text)) return
    await streamRun({ path: "/messages", body: { text, images }, userBubble: { text, images } })
  }

  const approve = React.useCallback(
    async (invId: string) => {
      try {
        await aiConversationService.approve(id, invId)
      } catch (e: unknown) {
        toast.error("同意失败", { description: (e as Error).message })
      }
    },
    [id],
  )
  const reject = React.useCallback(
    async (invId: string) => {
      try {
        await aiConversationService.reject(id, invId)
      } catch (e: unknown) {
        toast.error("拒绝失败", { description: (e as Error).message })
      }
    },
    [id],
  )
  const answer = React.useCallback(
    async (invId: string, text: string) => {
      try {
        await aiConversationService.answer(id, invId, text)
      } catch (e: unknown) {
        toast.error("提交失败", { description: (e as Error).message })
      }
    },
    [id],
  )
  const thinkingBudget = detail.data?.conversation?.thinking_budget ?? 0
  const setThinkingBudget = React.useCallback(
    async (n: number) => {
      try {
        await aiConversationService.update(id, { thinking_budget: n })
        qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
      } catch (e: unknown) {
        toast.error("设置失败", { description: (e as Error).message })
      }
    },
    [id, qc],
  )
  const cancel = React.useCallback(() => {
    abortRef.current?.abort()
    aiConversationService.cancel(id).catch(() => {
      /* ignore */
    })
    toast("已请求中断")
  }, [id])

  function lastUserText(): string | null {
    // Prefer last persisted user message; fall back to live user bubble.
    const persisted = [...(detail.data?.messages || [])]
      .reverse()
      .find((m) => m.role === "user")
    if (persisted) return parseContentText(persisted.content)
    const liveUser = [...live].reverse().find((b) => b.kind === "user")
    if (liveUser && liveUser.kind === "user") return liveUser.text
    return null
  }

  function regenerate() {
    if (running) return
    if (!lastUserText()) return
    // Real regenerate: the backend trims the last assistant turn + reruns.
    streamRun({ path: "/regenerate", body: {} })
  }

  function retry() {
    if (running) return
    const t = lastUserText()
    if (!t) return
    send(t)
  }

  const regenerateFromMessage = React.useCallback(
    (msg: import("@/lib/api/types").AIMessage) => {
      if (running) return
      const all = detail.data?.messages || []
      // Find the most recent user message preceding `msg.id`.
      let prev: import("@/lib/api/types").AIMessage | null = null
      for (const m of all) {
        if (m.id === msg.id) break
        if (m.role === "user") prev = m
      }
      if (!prev) return
      const text = parseContentText(prev.content)
      if (!text) return
      setDraft(text)
      setTimeout(() => composerRef.current?.focus(), 50)
    },
    [running, detail.data],
  )

  async function askDelete() {
    const ok = await confirmDialog({
      title: "删除这条对话？",
      description: "所有消息和工具调用都会被删除。",
      destructive: true,
    })
    if (ok) removeConv.mutate()
  }

  function exportJSON() {
    if (!detail.data) return
    const blob = new Blob([JSON.stringify(detail.data, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `conversation-${id}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast.success("已导出 JSON")
  }

  function exportMarkdown() {
    // Token-in-query so the browser's plain GET still authenticates.
    const url = aiConversationService.exportMarkdownURL(id)
    const a = document.createElement("a")
    a.href = url
    a.download = `conversation-${id}.md`
    document.body.appendChild(a)
    a.click()
    a.remove()
    toast.success("已导出 Markdown")
  }

  function changeModel(providerID: number, model: string) {
    aiConversationService
      .update(id, { provider_id: providerID, model })
      .then(() => {
        qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
        qc.invalidateQueries({ queryKey: ["ai", "convs"] })
        toast.success(`已切到模型 ${model}`)
      })
      .catch((e: unknown) =>
        toast.error("切换失败", { description: (e as Error).message }),
      )
  }

  async function editUserMessage(msg: import("@/lib/api/types").AIMessage, newText: string) {
    if (running) {
      toast.error("正在生成中，请先停止")
      return
    }
    // Edit-and-resend forks a new branch (the original is preserved) and streams
    // the new turn — the backend creates a sibling of the edited message.
    await streamRun({
      path: `/messages/${msg.id}/branch`,
      body: { text: newText },
      userBubble: { text: newText },
    })
  }

  const forkConversation = useMutation({
    mutationFn: () => aiConversationService.fork(id),
    onSuccess: (conv) => {
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
      toast.success("已克隆对话")
      router.push(`/ai/conversations/${conv.id}` as Parameters<typeof router.push>[0])
    },
    onError: (e: unknown) => toast.error("克隆失败", { description: (e as Error).message }),
  })

  // Live bubbles mirror the current turn's SSE stream. Once the persisted
  // history catches up (refetch lands with a higher message_count), the
  // server is the source of truth — drop the live overlay so we don't render
  // duplicates. Guard with !running so a stray refetch mid-stream can't
  // wipe in-flight output. We also keep system_notice/subagent bubbles
  // around: those are transient diagnostics not persisted by the backend.
  const prevCountRef = React.useRef(0)
  const pendingClearRef = React.useRef(false)
  React.useEffect(() => {
    const cur = detail.data?.conversation.message_count ?? 0
    const prev = prevCountRef.current
    prevCountRef.current = cur
    if (cur > prev && !running) {
      setLive((l) =>
        l.filter((b) => b.kind === "system_notice" || b.kind === "subagent"),
      )
    }
  }, [detail.data?.conversation.message_count, running])

  // After a completed run (any kind), drop the live overlay once the refetch
  // lands — covers regenerate/branch where message_count alone doesn't grow.
  React.useEffect(() => {
    if (running || !pendingClearRef.current) return
    pendingClearRef.current = false
    setLive((l) => l.filter((b) => b.kind === "system_notice" || b.kind === "subagent"))
  }, [detail.data, running])

  // Hydrate the task panel from the persisted plan on the conversation GET.
  // Guarded by !running so an in-flight plan_update isn't clobbered by a
  // background refetch (same principle as the live→history merge above).
  React.useEffect(() => {
    if (running) return
    const incoming = detail.data?.plan
    if (incoming && incoming.length) setPlan(mergePlanUpdate(incoming))
    else setPlan(EMPTY_PLAN)
  }, [detail.data?.plan, running])

  // Reset transient UI when switching between conversations.
  React.useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setLive([])
    setPlan(EMPTY_PLAN)
    setPlanCollapsed(false)
    setDraft("")
    setAttachments([])
    setRunning(false)
    setThinking(false)
    setUsageIn(0)
    setUsageOut(0)
    setSearchOpen(false)
    setHighlightMsgId(null)
    prevCountRef.current = 0
  }, [id])

  // Stall detector: if 30 s pass with no event during a run, surface a
  // single warning notice (idempotent by title).
  React.useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      if (Date.now() - lastEventAtRef.current > 30_000) {
        pushNotice(
          "warning",
          "模型久未响应",
          "已 30s 无新数据，可继续等待或点停止。",
          false,
          "模型久未响应",
        )
      }
    }, 5_000)
    return () => clearInterval(t)
  }, [running])

  // Esc cancels an in-flight generation (but not while the search overlay is
  // open — there Esc closes the overlay).
  React.useEffect(() => {
    if (!running) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !searchOpen) cancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [running, searchOpen, cancel])

  // Cmd/Ctrl+F opens the in-conversation search overlay.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // If the API returned 404 (or any error) and we have no cached detail,
  // render a friendly not-found screen instead of an empty header + composer
  // shell that pretends the conversation exists.
  const notFound =
    !detail.isLoading &&
    !detail.data &&
    (detail.error || detail.isError)

  if (notFound) {
    return <NotFoundView id={id} />
  }

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden min-w-0">
      <ConversationHeader
        conversation={detail.data?.conversation}
        agent={agent}
        liveTokensIn={usageIn}
        liveTokensOut={usageOut}
        liveToolCount={live.filter((b) => b.kind === "tool").length}
        onModeChange={(m) => changeMode.mutate(m)}
        onRegenerate={regenerate}
        onRename={(t) => renameConv.mutate(t)}
        onDelete={askDelete}
        onExport={exportJSON}
        onExportMarkdown={exportMarkdown}
        onModelChange={changeModel}
        onSearch={() => setSearchOpen(true)}
        onFork={() => forkConversation.mutate()}
        running={running}
      />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "chat" | "invocations")}
        className="flex-1 flex flex-col min-h-0"
      >
        <div className="border-b px-4 md:px-6">
          <TabsList className="bg-transparent gap-1 h-10 p-0 rounded-none">
            <AnimatedTabsTrigger value="chat" active={tab === "chat"}>
              对话
            </AnimatedTabsTrigger>
            <AnimatedTabsTrigger value="invocations" active={tab === "invocations"}>
              工具调用
              <span className="ml-1 inline-flex items-center justify-center rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {detail.data?.invocations?.length ?? 0}
              </span>
            </AnimatedTabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="chat"
          className="flex-1 min-h-0 m-0 flex overflow-hidden data-[state=inactive]:hidden"
          forceMount
        >
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            {searchOpen && (
              <ConversationSearch
                conversationId={id}
                onClose={() => setSearchOpen(false)}
                onJump={jumpToMessage}
              />
            )}
            {!isDesktop && plan.tasks.length > 0 && (
              <TaskPanel
                variant="inline"
                tasks={plan.tasks}
                running={running}
                collapsed={planCollapsed}
                onToggleCollapsed={() => setPlanCollapsed((v) => !v)}
              />
            )}
            <MessageList
              ref={messageListRef}
              messages={detail.data?.messages || []}
              invocations={detail.data?.invocations || []}
              live={live}
              running={running}
              thinking={
                thinking &&
                live.every(
                  (b) => b.kind !== "assistant" || b.chunks.length === 0,
                )
              }
              loading={detail.isLoading}
              agent={agent}
              highlightMsgId={highlightMsgId}
              branchSiblings={branchSiblings}
              onSwitchBranch={switchBranch}
              onApprove={approve}
              onReject={reject}
              onAnswer={answer}
              onRetry={retry}
              onRegenerateFrom={regenerateFromMessage}
              onEditUser={editUserMessage}
            />
            <Composer
              ref={composerRef}
              draft={draft}
              setDraft={setDraft}
              send={() => send()}
              cancel={cancel}
              running={running}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              vision={modelVision}
              thinkingBudget={thinkingBudget}
              onSetThinkingBudget={setThinkingBudget}
            />
          </div>
          {isDesktop && plan.tasks.length > 0 && (
            <div className="w-[300px] shrink-0 xl:w-[340px]">
              <TaskPanel variant="rail" tasks={plan.tasks} running={running} />
            </div>
          )}
        </TabsContent>

        <TabsContent
          value="invocations"
          className="flex-1 min-h-0 m-0 data-[state=inactive]:hidden"
          forceMount
        >
          <ScrollArea className="h-full">
            <InvocationTimeline invocations={detail.data?.invocations || []} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AnimatedTabsTrigger({
  value,
  active,
  children,
}: {
  value: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <TabsTrigger
      value={value}
      className="relative px-3 h-10 rounded-none bg-transparent text-muted-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:rounded"
    >
      {children}
      {active && (
        <motion.span
          layoutId="ai-tab-indicator"
          className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary rounded-full"
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
        />
      )}
    </TabsTrigger>
  )
}

function parseContentText(s: string): string {
  try {
    const parts = JSON.parse(s) as { text?: string }[]
    return parts.map((p) => p.text || "").join("")
  } catch {
    return s || ""
  }
}

function tryStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function NotFoundView({ id }: { id: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-background p-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        className="max-w-md w-full text-center space-y-5"
      >
        <div className="mx-auto w-14 h-14 rounded-2xl bg-muted/70 border border-border/60 flex items-center justify-center">
          <SearchX className="w-6 h-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">找不到这条对话</h2>
          <p className="text-sm text-muted-foreground">
            可能已被删除，或者链接里的 ID 不对。
          </p>
          <p className="text-[11px] font-mono text-muted-foreground break-all px-3 pt-1">
            {id}
          </p>
        </div>
        <div className="flex justify-center gap-2 pt-1">
          <Link
            href={"/ai" as Parameters<typeof Link>[0]["href"]}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground shadow hover:bg-primary/90 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ArrowLeft className="w-4 h-4" /> 返回 AI 助手
          </Link>
        </div>
      </motion.div>
    </div>
  )
}
