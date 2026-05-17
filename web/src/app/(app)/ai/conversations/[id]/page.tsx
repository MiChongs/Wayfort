"use client"

import * as React from "react"
import { use } from "react"
import { motion } from "motion/react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, SearchX } from "lucide-react"
import { toast } from "sonner"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { aiAgentService, aiConversationService } from "@/lib/api/services"
import { streamSSE } from "@/lib/sse/eventsource"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { ConversationHeader } from "@/components/ai/conversation-header"
import { Composer } from "@/components/ai/composer"
import { MessageList, type LiveBubble } from "@/components/ai/message-list"
import { InvocationTimeline } from "@/components/ai/invocation-timeline"
import { isDangerName } from "@/components/ai/tool-icons"
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
  const agent = React.useMemo(() => {
    const aid = detail.data?.conversation.agent_id
    if (!aid) return undefined
    return agentsQuery.data?.agents.find((a) => a.id === aid)
  }, [detail.data, agentsQuery.data])

  const [draft, setDraft] = React.useState("")
  const [live, setLive] = React.useState<LiveBubble[]>([])
  const [running, setRunning] = React.useState(false)
  const [thinking, setThinking] = React.useState(false)
  const [usageIn, setUsageIn] = React.useState(0)
  const [usageOut, setUsageOut] = React.useState(0)
  const abortRef = React.useRef<AbortController | null>(null)
  const noticeSeqRef = React.useRef(0)
  const lastEventAtRef = React.useRef<number>(0)
  const [tab, setTab] = React.useState<"chat" | "invocations">("chat")
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null)

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
        next.push({ kind: "assistant", chunks: [buffered], streaming: true })
      }
      return next
    })
  }, [])

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
    // Stop the "thinking" spinner once any concrete event arrives.
    if (
      ev.kind === "text_delta" ||
      ev.kind === "tool_call" ||
      ev.kind === "tool_output" ||
      ev.kind === "message_start" ||
      ev.kind === "permission_required"
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
          next.push({ kind: "assistant", chunks: [], streaming: true })
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

  async function send(textOverride?: string) {
    const text = (textOverride ?? draft).trim()
    if (!text || running) return
    setDraft("")
    if (await handleSlash(text)) return
    setLive((l) => [
      ...l,
      { kind: "user", text },
      { kind: "assistant", chunks: [], streaming: true },
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
        `/api/proxy/api/v1/ai/conversations/${id}/messages`,
        { method: "POST", body: { text }, signal: ctrl.signal },
        (kind, data) => {
          const ev = { kind, ...(data as object) } as StreamEvent
          dispatchEvent(ev)
        },
      )
    } catch (e: unknown) {
      if (ctrl.signal.aborted) {
        pushNotice(
          "info",
          "已中止生成",
          "用户取消了本轮回复，可点重新发送上一条消息。",
          true,
        )
      } else {
        pushNotice("error", "连接失败", (e as Error).message, true)
      }
    } finally {
      setRunning(false)
      setThinking(false)
      // Flush any pending text/reasoning before finalising.
      if (pendingTextRef.current) flushText()
      if (pendingReasoningRef.current) flushReasoning()
      // Mark trailing assistant + any still-open reasoning as no-longer-streaming
      // so caret hides and reasoning collapses to its "已思考 Xs" form.
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
      qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
    }
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
    const t = lastUserText()
    if (!t) return
    setDraft(t)
    setTimeout(() => composerRef.current?.focus(), 50)
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
    try {
      await aiConversationService.editMessage(id, msg.id, newText)
      qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
      // Auto-trigger the next turn with the edited text.
      setTimeout(() => send(newText), 50)
    } catch (e: unknown) {
      toast.error("编辑失败", { description: (e as Error).message })
    }
  }

  // Live bubbles mirror the current turn's SSE stream. Once the persisted
  // history catches up (refetch lands with a higher message_count), the
  // server is the source of truth — drop the live overlay so we don't render
  // duplicates. Guard with !running so a stray refetch mid-stream can't
  // wipe in-flight output. We also keep system_notice/subagent bubbles
  // around: those are transient diagnostics not persisted by the backend.
  const prevCountRef = React.useRef(0)
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

  // Reset transient UI when switching between conversations.
  React.useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setLive([])
    setDraft("")
    setRunning(false)
    setThinking(false)
    setUsageIn(0)
    setUsageOut(0)
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

  // Esc cancels an in-flight generation.
  React.useEffect(() => {
    if (!running) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") cancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [running])

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
          className="flex-1 min-h-0 m-0 flex flex-col overflow-hidden data-[state=inactive]:hidden"
          forceMount
        >
          <MessageList
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
            onApprove={approve}
            onReject={reject}
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
          />
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
