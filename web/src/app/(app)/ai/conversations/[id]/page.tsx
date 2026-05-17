"use client"

import * as React from "react"
import { use } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { aiConversationService } from "@/lib/api/services"
import { streamSSE } from "@/lib/sse/eventsource"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { ConversationHeader } from "@/components/ai/conversation-header"
import { Composer } from "@/components/ai/composer"
import { MessageList, type LiveBubble } from "@/components/ai/message-list"
import { InvocationTimeline } from "@/components/ai/invocation-timeline"
import { isDangerName } from "@/components/ai/tool-icons"
import type { PermissionMode } from "@/lib/api/types"

type StreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; id: string; name: string }
  | { kind: "permission_required"; invocation_id: string; tool: string; summary: string }
  | { kind: "tool_start"; id: string; invocation_id: string }
  | { kind: "tool_output"; id: string; output: string; dry_run?: boolean; truncated?: boolean }
  | { kind: "tool_error"; id: string; error: string }
  | { kind: "usage"; input_tokens: number; output_tokens: number }
  | { kind: "message_end"; finish_reason: string }
  | { kind: "error"; error: string }

export default function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const qc = useQueryClient()
  const router = useRouter()
  const detail = useQuery({
    queryKey: ["ai", "conv", id],
    queryFn: () => aiConversationService.get(id),
  })

  const [draft, setDraft] = React.useState("")
  const [live, setLive] = React.useState<LiveBubble[]>([])
  const [running, setRunning] = React.useState(false)
  const [thinking, setThinking] = React.useState(false)
  const [usageIn, setUsageIn] = React.useState(0)
  const [usageOut, setUsageOut] = React.useState(0)
  const abortRef = React.useRef<AbortController | null>(null)
  const [tab, setTab] = React.useState<"chat" | "invocations">("chat")
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null)

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

  async function send() {
    if (!draft.trim() || running) return
    const text = draft.trim()
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
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await streamSSE(
        `/api/proxy/api/v1/ai/conversations/${id}/messages`,
        { method: "POST", body: { text }, signal: ctrl.signal },
        (kind, data) => onEvent({ kind, ...(data as object) } as StreamEvent),
      )
    } catch (e: unknown) {
      if (!ctrl.signal.aborted)
        toast.error("流式失败", { description: (e as Error).message })
    } finally {
      setRunning(false)
      setThinking(false)
      // Mark trailing assistant bubble as no longer streaming so caret hides.
      setLive((l) => {
        if (l.length === 0) return l
        const next = l.slice()
        const last = next[next.length - 1]
        if (last && last.kind === "assistant") {
          next[next.length - 1] = { ...last, streaming: false }
        }
        return next
      })
      qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
      qc.invalidateQueries({ queryKey: ["ai", "convs"] })
    }
  }

  function onEvent(ev: StreamEvent) {
    if (ev.kind === "text_delta" || ev.kind === "tool_call" || ev.kind === "tool_output") {
      setThinking(false)
    }
    setLive((l) => {
      const next = l.slice()
      switch (ev.kind) {
        case "text_delta": {
          const last = next[next.length - 1]
          if (last && last.kind === "assistant") {
            next[next.length - 1] = {
              ...last,
              chunks: [...last.chunks, ev.text],
              streaming: true,
            }
          } else {
            next.push({ kind: "assistant", chunks: [ev.text], streaming: true })
          }
          break
        }
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
          const idx = next.findIndex((x) => x.kind === "tool" && x.id === ev.id)
          if (idx >= 0) {
            const t = next[idx] as Extract<LiveBubble, { kind: "tool" }>
            next[idx] = { ...t, status: "running", invocationId: ev.invocation_id }
          }
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i]
            if (b.kind === "permission" && b.invocationId === ev.invocation_id) {
              next.splice(i, 1)
              break
            }
          }
          break
        }
        case "tool_output": {
          const idx = next.findIndex((x) => x.kind === "tool" && x.id === ev.id)
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
          const idx = next.findIndex((x) => x.kind === "tool" && x.id === ev.id)
          if (idx >= 0) {
            const t = next[idx] as Extract<LiveBubble, { kind: "tool" }>
            next[idx] = { ...t, status: "error", error: ev.error }
          }
          break
        }
        case "usage":
          setUsageIn((v) => v + ev.input_tokens)
          setUsageOut((v) => v + ev.output_tokens)
          break
      }
      return next
    })
  }

  async function approve(invId: string) {
    try {
      await aiConversationService.approve(id, invId)
    } catch (e: unknown) {
      toast.error("同意失败", { description: (e as Error).message })
    }
  }
  async function reject(invId: string) {
    try {
      await aiConversationService.reject(id, invId)
    } catch (e: unknown) {
      toast.error("拒绝失败", { description: (e as Error).message })
    }
  }
  function cancel() {
    abortRef.current?.abort()
    aiConversationService.cancel(id).catch(() => {
      /* ignore */
    })
    toast("已请求中断")
  }

  async function regenerate() {
    if (running) return
    const messages = detail.data?.messages || []
    const lastUser = [...messages].reverse().find((m) => m.role === "user")
    if (!lastUser) return
    const lastText = parseContentText(lastUser.content)
    if (!lastText) return
    setDraft(lastText)
    setTimeout(() => composerRef.current?.focus(), 50)
  }

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

  // Live bubbles mirror the current turn's SSE stream. Once the persisted
  // history catches up (refetch lands with a higher message_count), the
  // server is the source of truth — drop the live overlay so we don't render
  // duplicates. Guard with !running so a stray refetch mid-stream can't
  // wipe in-flight output.
  const prevCountRef = React.useRef(0)
  React.useEffect(() => {
    const cur = detail.data?.conversation.message_count ?? 0
    const prev = prevCountRef.current
    prevCountRef.current = cur
    if (cur > prev && !running) setLive([])
  }, [detail.data?.conversation.message_count, running])

  // Reset transient UI when switching between conversations. Without this,
  // an in-flight stream from a previous conversation could keep showing
  // bubbles under the new conversation if the component instance is reused.
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

  return (
    <div className="flex flex-col h-full bg-background">
      <ConversationHeader
        conversation={detail.data?.conversation}
        liveTokensIn={usageIn}
        liveTokensOut={usageOut}
        onModeChange={(m) => changeMode.mutate(m)}
        onRegenerate={regenerate}
        onRename={(t) => renameConv.mutate(t)}
        onDelete={askDelete}
        onExport={exportJSON}
        running={running}
      />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "chat" | "invocations")}
        className="flex-1 flex flex-col min-h-0"
      >
        <div className="border-b px-4 md:px-6">
          <TabsList className="bg-transparent gap-2 h-9 p-0">
            <TabsTrigger
              value="chat"
              className="data-[state=active]:bg-accent rounded-md"
            >
              对话
            </TabsTrigger>
            <TabsTrigger
              value="invocations"
              className="data-[state=active]:bg-accent rounded-md"
            >
              工具调用 ({detail.data?.invocations?.length ?? 0})
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="chat"
          className="flex-1 min-h-0 m-0 flex flex-col data-[state=inactive]:hidden"
          forceMount
        >
          <MessageList
            messages={detail.data?.messages || []}
            invocations={detail.data?.invocations || []}
            live={live}
            running={running}
            thinking={thinking && live.every((b) => b.kind !== "assistant" || b.chunks.length === 0)}
            onApprove={approve}
            onReject={reject}
          />
          <Composer
            ref={composerRef}
            draft={draft}
            setDraft={setDraft}
            send={send}
            cancel={cancel}
            running={running}
          />
        </TabsContent>

        <TabsContent
          value="invocations"
          className="flex-1 min-h-0 m-0 overflow-y-auto data-[state=inactive]:hidden"
          forceMount
        >
          <InvocationTimeline invocations={detail.data?.invocations || []} />
        </TabsContent>
      </Tabs>
    </div>
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
