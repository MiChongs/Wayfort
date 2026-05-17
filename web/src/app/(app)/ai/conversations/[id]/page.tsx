"use client"

import * as React from "react"
import { use } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Bot, Check, Loader2, Pause, Send, ShieldAlert, Sparkles, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select"
import { aiConversationService } from "@/lib/api/services"
import { streamSSE } from "@/lib/sse/eventsource"
import { Markdown } from "@/components/ai/markdown"
import { fmtBytes } from "@/lib/format"
import type { AIMessage, AIToolInvocation, PermissionMode } from "@/lib/api/types"

type StreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; id: string; name: string }
  | { kind: "permission_required"; invocation_id: string; tool: string; summary: string; arguments: unknown }
  | { kind: "tool_start"; id: string; invocation_id: string }
  | { kind: "tool_output"; id: string; output: string; dry_run?: boolean; truncated?: boolean }
  | { kind: "tool_error"; id: string; error: string }
  | { kind: "usage"; input_tokens: number; output_tokens: number }
  | { kind: "message_end"; finish_reason: string }
  | { kind: "error"; error: string }

type LiveBubble =
  | { type: "assistant_text"; text: string }
  | { type: "tool"; id: string; invocationId?: string; name: string; status: "pending" | "running" | "output" | "error" | "dry_run"; output?: string; error?: string }
  | { type: "permission"; invocationId: string; tool: string; summary: string }
  | { type: "user"; text: string }

export default function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const qc = useQueryClient()
  const detail = useQuery({ queryKey: ["ai", "conv", id], queryFn: () => aiConversationService.get(id) })

  const [draft, setDraft] = React.useState("")
  const [live, setLive] = React.useState<LiveBubble[]>([])
  const [running, setRunning] = React.useState(false)
  const [usageIn, setUsageIn] = React.useState(0)
  const [usageOut, setUsageOut] = React.useState(0)
  const abortRef = React.useRef<AbortController | null>(null)
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null)

  // Auto-scroll the message list to bottom on new content.
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live, detail.data])

  const changeMode = useMutation({
    mutationFn: (mode: PermissionMode) => aiConversationService.update(id, { permission_mode: mode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai", "conv", id] }),
  })

  async function send() {
    if (!draft.trim() || running) return
    const text = draft
    setDraft("")
    setLive((l) => [...l, { type: "user", text }, { type: "assistant_text", text: "" }])
    setRunning(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await streamSSE(
        `/api/proxy/api/v1/ai/conversations/${id}/messages`,
        { method: "POST", body: { text }, signal: ctrl.signal },
        (kind, data) => onEvent({ kind, ...(data as object) } as StreamEvent)
      )
    } catch (e: unknown) {
      if (!ctrl.signal.aborted) toast.error("流式失败", { description: (e as Error).message })
    } finally {
      setRunning(false)
      qc.invalidateQueries({ queryKey: ["ai", "conv", id] })
    }
  }

  function onEvent(ev: StreamEvent) {
    setLive((l) => {
      const next = l.slice()
      switch (ev.kind) {
        case "text_delta": {
          const last = next[next.length - 1]
          if (last && last.type === "assistant_text") last.text += ev.text
          else next.push({ type: "assistant_text", text: ev.text })
          break
        }
        case "tool_call":
          next.push({ type: "tool", id: ev.id, name: ev.name, status: "pending" })
          break
        case "permission_required":
          next.push({ type: "permission", invocationId: ev.invocation_id, tool: ev.tool, summary: ev.summary })
          break
        case "tool_start": {
          const t = next.find((x) => x.type === "tool" && x.id === ev.id) as Extract<LiveBubble, { type: "tool" }> | undefined
          if (t) { t.status = "running"; t.invocationId = ev.invocation_id }
          // drop the permission bubble for this invocation
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i]
            if (b.type === "permission" && b.invocationId === ev.invocation_id) {
              next.splice(i, 1); break
            }
          }
          break
        }
        case "tool_output": {
          const t = next.find((x) => x.type === "tool" && x.id === ev.id) as Extract<LiveBubble, { type: "tool" }> | undefined
          if (t) { t.status = ev.dry_run ? "dry_run" : "output"; t.output = ev.output }
          // assistant may continue talking → push a fresh empty bubble so further deltas land in a new one
          next.push({ type: "assistant_text", text: "" })
          break
        }
        case "tool_error": {
          const t = next.find((x) => x.type === "tool" && x.id === ev.id) as Extract<LiveBubble, { type: "tool" }> | undefined
          if (t) { t.status = "error"; t.error = ev.error }
          break
        }
        case "usage":
          setUsageIn((v) => v + ev.input_tokens)
          setUsageOut((v) => v + ev.output_tokens)
          break
        case "message_end":
        case "error":
          break
      }
      return next
    })
  }

  async function approve(invId: string) {
    try { await aiConversationService.approve(id, invId) } catch (e: unknown) { toast.error("同意失败", { description: (e as Error).message }) }
  }
  async function reject(invId: string) {
    try { await aiConversationService.reject(id, invId) } catch (e: unknown) { toast.error("拒绝失败", { description: (e as Error).message }) }
  }
  function cancel() {
    abortRef.current?.abort()
    aiConversationService.cancel(id).catch(() => { /* ignore */ })
  }

  // Render the persisted history first, then live deltas on top.
  const persistedBubbles = renderMessages(detail.data?.messages || [], detail.data?.invocations || [])

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="border-b px-6 py-3 flex items-center justify-between bg-card">
        <div>
          <div className="font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            {detail.data?.conversation.title || "对话"}
          </div>
          <div className="text-xs text-muted-foreground">
            模型 {detail.data?.conversation.model || "未指定"} · token in {usageIn + (detail.data?.conversation.total_input_tokens || 0)} · out {usageOut + (detail.data?.conversation.total_output_tokens || 0)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={detail.data?.conversation.permission_mode || "normal"}
            onValueChange={(v) => changeMode.mutate(v as PermissionMode)}
          >
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="plan">plan（仅规划，dry-run）</SelectItem>
              <SelectItem value="normal">normal（写操作需确认）</SelectItem>
              <SelectItem value="bypass">bypass（直接执行）</SelectItem>
            </SelectContent>
          </Select>
          {running && (
            <Button variant="outline" size="sm" onClick={cancel}><Pause className="w-4 h-4" /> 取消</Button>
          )}
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-3 bg-muted/30">
        {persistedBubbles}
        {live.map((b, i) => <LiveBubbleView key={i} b={b} approve={approve} reject={reject} />)}
      </div>
      <div className="border-t bg-background p-3">
        <div className="flex gap-2">
          <Textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="输入你的指令… (Enter 发送，Shift+Enter 换行)"
            rows={2}
            className="flex-1"
          />
          <Button onClick={send} disabled={running || !draft.trim()}>
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            发送
          </Button>
        </div>
      </div>
    </div>
  )
}

function LiveBubbleView({ b, approve, reject }: { b: LiveBubble; approve: (id: string) => void; reject: (id: string) => void }) {
  if (b.type === "user") return <UserBubble text={b.text} />
  if (b.type === "assistant_text") return b.text ? <AssistantBubble text={b.text} /> : null
  if (b.type === "tool") return <ToolBubble b={b} />
  if (b.type === "permission") return <PermissionBubble b={b} approve={approve} reject={reject} />
  return null
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="bg-primary text-primary-foreground rounded-2xl px-4 py-2 max-w-2xl whitespace-pre-wrap">{text}</div>
    </div>
  )
}

function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-card border flex items-center justify-center shrink-0">
        <Bot className="w-4 h-4" />
      </div>
      <Card className="flex-1 max-w-3xl">
        <CardContent className="pt-4 pb-4">
          <Markdown text={text} />
        </CardContent>
      </Card>
    </div>
  )
}

function ToolBubble({ b }: { b: Extract<LiveBubble, { type: "tool" }> }) {
  const colors: Record<string, string> = {
    pending: "border-amber-500/40 bg-amber-500/10",
    running: "border-blue-500/40 bg-blue-500/10",
    output: "border-emerald-500/40 bg-emerald-500/10",
    dry_run: "border-zinc-500/40 bg-zinc-500/10",
    error: "border-destructive/50 bg-destructive/10",
  }
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <div className={`flex-1 max-w-3xl rounded-lg border px-3 py-2 text-sm ${colors[b.status]}`}>
        <div className="flex items-center gap-2 font-medium">
          <ShieldAlert className="w-4 h-4" />
          tool · {b.name}
          <Badge variant="outline" className="ml-auto">{b.status}</Badge>
        </div>
        {b.output && (
          <pre className="mt-2 whitespace-pre-wrap text-xs bg-zinc-950 text-zinc-100 p-2 rounded overflow-auto max-h-72">{b.output}</pre>
        )}
        {b.error && <div className="mt-2 text-xs text-destructive">{b.error}</div>}
      </div>
    </div>
  )
}

function PermissionBubble({ b, approve, reject }: { b: Extract<LiveBubble, { type: "permission" }>; approve: (id: string) => void; reject: (id: string) => void }) {
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <Card className="flex-1 max-w-3xl border-amber-500/60 bg-amber-500/5">
        <CardContent className="pt-4 pb-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-medium text-sm">
            <AlertTriangle className="w-4 h-4" />
            Agent 想调用工具 <code className="font-mono">{b.tool}</code>
          </div>
          <div className="text-sm">{b.summary}</div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => approve(b.invocationId)}><Check className="w-4 h-4" /> 同意</Button>
            <Button size="sm" variant="outline" onClick={() => reject(b.invocationId)}><X className="w-4 h-4" /> 拒绝</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function renderMessages(messages: AIMessage[], invocations: AIToolInvocation[]) {
  const out: React.ReactNode[] = []
  const invByCallId = new Map<string, AIToolInvocation>()
  // We don't have the LLM-side tool_call_id on invocations directly; index by name+timestamp is best-effort.
  for (const inv of invocations) invByCallId.set(inv.id, inv)

  for (const m of messages) {
    let parts: { text?: string }[] = []
    try { parts = JSON.parse(m.content || "[]") as { text?: string }[] } catch { /* */ }
    const text = parts.map((p) => p.text || "").join("")
    if (m.role === "user") out.push(<UserBubble key={m.id} text={text} />)
    else if (m.role === "assistant") {
      if (text) out.push(<AssistantBubble key={m.id} text={text} />)
      if (m.tool_calls) {
        try {
          const tcs = JSON.parse(m.tool_calls) as { id: string; name: string; arguments: string }[]
          for (const tc of tcs) {
            const inv = invocations.find((i) => i.tool_name === tc.name)
            const status = (inv?.status || "succeeded") as "pending" | "running" | "succeeded" | "failed" | "dry_run" | "rejected" | "approved"
            const mapped: Extract<LiveBubble, { type: "tool" }>["status"] =
              status === "failed" || status === "rejected" ? "error" :
              status === "dry_run" ? "dry_run" :
              status === "pending" || status === "approved" ? "running" :
              status === "running" ? "running" : "output"
            out.push(
              <ToolBubble
                key={`${m.id}-${tc.id}`}
                b={{ type: "tool", id: tc.id, name: tc.name, status: mapped, output: inv?.output, error: inv?.error }}
              />
            )
          }
        } catch { /* */ }
      }
    } else if (m.role === "tool") {
      // Tool result is already shown as ToolBubble.output above; skip.
    }
  }
  return out
}

// keep fmtBytes import alive
export { fmtBytes }
