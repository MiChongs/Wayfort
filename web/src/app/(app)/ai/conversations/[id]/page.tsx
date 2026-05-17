"use client"

import * as React from "react"
import { use } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle, Bot, Check, Clock, Copy, Loader2, Pause, RefreshCw, Send, ShieldAlert,
  Sparkles, Trash2, User, X,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { aiConversationService } from "@/lib/api/services"
import { streamSSE } from "@/lib/sse/eventsource"
import { Markdown } from "@/components/ai/markdown"
import { ToolOutputView } from "@/components/ai/tool-output"
import { CopyButton } from "@/components/common/copy-button"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AIMessage, AIToolInvocation, PermissionMode } from "@/lib/api/types"
import { confirmDialog } from "@/components/common/confirm-dialog"

// ---------- Bubble model ----------
//
// We keep an in-memory "live" list of bubbles that mirrors the SSE stream and
// merges with the persisted history fetched from `/conversations/:id`. The
// merger is purely additive: on every conversation refetch we recompute the
// persisted half; live bubbles for the current turn sit on top until the turn
// ends and React Query refetch wipes them.

type LiveBubble =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; invocationId?: string; name: string; status: ToolStatus; output?: string; error?: string; danger?: boolean }
  | { kind: "permission"; invocationId: string; tool: string; summary: string; danger?: boolean }

type ToolStatus = "pending" | "running" | "output" | "error" | "dry_run"

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

const SLASH_COMMANDS = [
  { cmd: "/clear", desc: "清空本对话（不可恢复）", danger: true },
  { cmd: "/plan", desc: "切到 plan 模式（dry-run）" },
  { cmd: "/normal", desc: "切到 normal 模式（写需确认）" },
  { cmd: "/bypass", desc: "切到 bypass 模式（直接执行）" },
  { cmd: "/cancel", desc: "中断当前生成" },
]

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
  const [tab, setTab] = React.useState<"chat" | "invocations">("chat")
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live, detail.data])

  // Hint slash-completion: shows a tiny pop-up under composer.
  const slashHint = React.useMemo(() => {
    if (!draft.startsWith("/")) return null
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(draft.toLowerCase()))
  }, [draft])

  const changeMode = useMutation({
    mutationFn: (mode: PermissionMode) => aiConversationService.update(id, { permission_mode: mode }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ai", "conv", id] }); toast.success("已切换权限模式") },
  })

  const removeConv = useMutation({
    mutationFn: () => aiConversationService.remove(id),
    onSuccess: () => { toast.success("已删除对话"); window.location.href = "/ai" },
  })

  async function handleSlash(cmd: string): Promise<boolean> {
    if (!cmd.startsWith("/")) return false
    const c = cmd.trim().toLowerCase()
    if (c === "/clear") {
      const ok = await confirmDialog({ title: "清空当前对话？", description: "所有消息和工具调用都会被删除。", destructive: true })
      if (ok) removeConv.mutate()
      return true
    }
    if (c === "/plan" || c === "/normal" || c === "/bypass") {
      changeMode.mutate(c.slice(1) as PermissionMode)
      return true
    }
    if (c === "/cancel") { cancel(); return true }
    return false
  }

  async function send() {
    if (!draft.trim() || running) return
    const text = draft.trim()
    setDraft("")
    if (await handleSlash(text)) return
    setLive((l) => [...l, { kind: "user", text }, { kind: "assistant", text: "" }])
    setRunning(true)
    setUsageIn(0); setUsageOut(0)
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
          if (last && last.kind === "assistant") last.text += ev.text
          else next.push({ kind: "assistant", text: ev.text })
          break
        }
        case "tool_call":
          next.push({ kind: "tool", id: ev.id, name: ev.name, status: "pending", danger: isDangerName(ev.name) })
          break
        case "permission_required":
          next.push({ kind: "permission", invocationId: ev.invocation_id, tool: ev.tool, summary: ev.summary, danger: isDangerName(ev.tool) })
          break
        case "tool_start": {
          const t = next.find((x) => x.kind === "tool" && x.id === ev.id) as Extract<LiveBubble, { kind: "tool" }> | undefined
          if (t) { t.status = "running"; t.invocationId = ev.invocation_id }
          for (let i = next.length - 1; i >= 0; i--) {
            const b = next[i]
            if (b.kind === "permission" && b.invocationId === ev.invocation_id) { next.splice(i, 1); break }
          }
          break
        }
        case "tool_output": {
          const t = next.find((x) => x.kind === "tool" && x.id === ev.id) as Extract<LiveBubble, { kind: "tool" }> | undefined
          if (t) { t.status = ev.dry_run ? "dry_run" : "output"; t.output = ev.output }
          next.push({ kind: "assistant", text: "" })
          break
        }
        case "tool_error": {
          const t = next.find((x) => x.kind === "tool" && x.id === ev.id) as Extract<LiveBubble, { kind: "tool" }> | undefined
          if (t) { t.status = "error"; t.error = ev.error }
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
    try { await aiConversationService.approve(id, invId) } catch (e: unknown) { toast.error("同意失败", { description: (e as Error).message }) }
  }
  async function reject(invId: string) {
    try { await aiConversationService.reject(id, invId) } catch (e: unknown) { toast.error("拒绝失败", { description: (e as Error).message }) }
  }
  function cancel() {
    abortRef.current?.abort()
    aiConversationService.cancel(id).catch(() => { /* ignore */ })
    toast("已请求中断")
  }

  async function regenerate() {
    if (running) return
    const lastUser = [...(detail.data?.messages || [])].reverse().find((m) => m.role === "user")
    if (!lastUser) return
    const lastText = parseContentText(lastUser.content)
    if (!lastText) return
    setDraft(lastText)
    setTimeout(() => composerRef.current?.focus(), 50)
  }

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="border-b px-4 md:px-6 py-3 flex items-center justify-between bg-card flex-wrap gap-2">
        <div className="min-w-0">
          <div className="font-medium flex items-center gap-2 truncate">
            <Sparkles className="w-4 h-4 shrink-0" />
            <span className="truncate">{detail.data?.conversation.title || "对话"}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            <span>模型 {detail.data?.conversation.model || "—"}</span>
            <span className="mx-2">·</span>
            <span>token in {(detail.data?.conversation.total_input_tokens || 0) + usageIn}</span>
            <span className="mx-1">/</span>
            <span>out {(detail.data?.conversation.total_output_tokens || 0) + usageOut}</span>
            <span className="mx-2">·</span>
            <span>{detail.data?.conversation.message_count || 0} 条消息</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={detail.data?.conversation.permission_mode || "normal"}
            onValueChange={(v) => changeMode.mutate(v as PermissionMode)}
          >
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="plan">plan（仅规划 dry-run）</SelectItem>
              <SelectItem value="normal">normal（写操作需确认）</SelectItem>
              <SelectItem value="bypass">bypass（直接执行）</SelectItem>
            </SelectContent>
          </Select>
          {running && (
            <Button variant="outline" size="sm" onClick={cancel}><Pause className="w-4 h-4" /> 取消</Button>
          )}
          <Button variant="ghost" size="icon" onClick={regenerate} title="重发最后一条用户消息">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "chat" | "invocations")} className="flex-1 flex flex-col min-h-0">
        <div className="border-b px-4 md:px-6">
          <TabsList className="bg-transparent gap-2 h-9">
            <TabsTrigger value="chat" className="data-[state=active]:bg-accent">对话</TabsTrigger>
            <TabsTrigger value="invocations" className="data-[state=active]:bg-accent">
              工具调用 ({detail.data?.invocations?.length ?? 0})
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="chat" className="flex-1 min-h-0 m-0 flex flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-3 bg-muted/30">
            {renderHistory(detail.data?.messages || [], detail.data?.invocations || [])}
            {live.map((b, i) => <LiveBubbleView key={i} b={b} approve={approve} reject={reject} />)}
            {running && <RunningIndicator />}
          </div>
          <Composer
            ref={composerRef}
            draft={draft}
            setDraft={setDraft}
            send={send}
            running={running}
            slashHint={slashHint}
          />
        </TabsContent>

        <TabsContent value="invocations" className="flex-1 min-h-0 m-0 overflow-y-auto">
          <InvocationList invocations={detail.data?.invocations || []} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------- Composer ----------

const Composer = React.forwardRef<HTMLTextAreaElement, {
  draft: string
  setDraft: (s: string) => void
  send: () => void
  running: boolean
  slashHint: { cmd: string; desc: string; danger?: boolean }[] | null
}>(function Composer({ draft, setDraft, send, running, slashHint }, ref) {
  return (
    <div className="border-t bg-background p-3 relative">
      {slashHint && slashHint.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-2 rounded-md border bg-popover shadow-md p-2 space-y-1">
          {slashHint.map((c) => (
            <button
              key={c.cmd}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setDraft(c.cmd) }}
              className="w-full text-left flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-accent"
            >
              <code className="font-mono text-xs">{c.cmd}</code>
              <span className="text-xs text-muted-foreground">{c.desc}</span>
              {c.danger && <Badge variant="destructive" className="ml-auto">危险</Badge>}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="输入你的指令… （Enter 发送，Shift+Enter 换行，斜杠开头查看快捷命令）"
          rows={2}
          className="flex-1 max-h-40"
        />
        <Button onClick={send} disabled={running || !draft.trim()}>
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          发送
        </Button>
      </div>
    </div>
  )
})

// ---------- Persisted history ----------

function renderHistory(messages: AIMessage[], invocations: AIToolInvocation[]): React.ReactNode[] {
  const out: React.ReactNode[] = []
  // Walk in order, but consume tool messages as inputs to the preceding tool calls.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const text = parseContentText(m.content)
    if (m.role === "user") {
      out.push(<UserBubble key={m.id} text={text} />)
    } else if (m.role === "assistant") {
      if (text) out.push(<AssistantBubble key={m.id} text={text} />)
      if (m.tool_calls) {
        try {
          const tcs = JSON.parse(m.tool_calls) as { id: string; name: string; arguments: string }[]
          for (const tc of tcs) {
            // Pair each tool_call with the tool result message that follows.
            let result = ""
            for (let j = i + 1; j < messages.length; j++) {
              if (messages[j].role === "tool" && messages[j].tool_call_id === tc.id) {
                result = parseContentText(messages[j].content)
                break
              }
            }
            const inv = invocations.find((iv) => iv.tool_name === tc.name) // best-effort match
            const status: ToolStatus =
              inv?.status === "failed" || inv?.status === "rejected" ? "error" :
              inv?.status === "dry_run" ? "dry_run" :
              inv?.status === "pending" || inv?.status === "running" ? "running" : "output"
            out.push(
              <ToolBubble
                key={`${m.id}-${tc.id}`}
                b={{ kind: "tool", id: tc.id, name: tc.name, status, output: result || inv?.output, error: inv?.error, danger: isDangerName(tc.name) }}
              />
            )
          }
        } catch { /* ignore */ }
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

// ---------- Bubbles ----------

function LiveBubbleView({ b, approve, reject }: {
  b: LiveBubble
  approve: (id: string) => void
  reject: (id: string) => void
}) {
  if (b.kind === "user") return <UserBubble text={b.text} />
  if (b.kind === "assistant") return b.text ? <AssistantBubble text={b.text} /> : null
  if (b.kind === "tool") return <ToolBubble b={b} />
  if (b.kind === "permission") return <PermissionBubble b={b} approve={approve} reject={reject} />
  return null
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end gap-3 group">
      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-start pt-1">
        <CopyButton value={text} variant="ghost" />
      </div>
      <div className="bg-primary text-primary-foreground rounded-2xl px-4 py-2 max-w-2xl whitespace-pre-wrap">{text}</div>
      <div className="w-7 h-7 rounded-full bg-card border flex items-center justify-center shrink-0">
        <User className="w-4 h-4" />
      </div>
    </div>
  )
}

function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-3 group">
      <div className="w-7 h-7 rounded-full bg-card border flex items-center justify-center shrink-0">
        <Bot className="w-4 h-4" />
      </div>
      <Card className="flex-1 max-w-3xl">
        <CardContent className="pt-4 pb-4 relative">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-2 right-2">
            <CopyButton value={text} variant="ghost" />
          </div>
          <Markdown text={text} />
        </CardContent>
      </Card>
    </div>
  )
}

function ToolBubble({ b }: { b: Extract<LiveBubble, { kind: "tool" }> }) {
  const colors: Record<ToolStatus, string> = {
    pending: "border-amber-500/40 bg-amber-500/5",
    running: "border-blue-500/40 bg-blue-500/5",
    output: "border-emerald-500/40 bg-emerald-500/5",
    dry_run: "border-zinc-500/40 bg-zinc-500/5",
    error: "border-destructive/50 bg-destructive/5",
  }
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0" />
      <div className={cn("flex-1 max-w-3xl rounded-lg border px-3 py-2 text-sm", colors[b.status])}>
        <div className="flex items-center gap-2 font-medium text-xs">
          <ShieldAlert className="w-4 h-4" />
          <code className="font-mono">{b.name}</code>
          {b.danger && <Badge variant="destructive" className="text-[10px]">高危</Badge>}
          <Badge variant="outline" className="ml-auto">{b.status}</Badge>
          {b.status === "running" && <Loader2 className="w-3 h-3 animate-spin" />}
        </div>
        {b.output && <div className="mt-2"><ToolOutputView raw={b.output} danger={b.danger} /></div>}
        {b.error && <div className="mt-2 text-xs text-destructive">{b.error}</div>}
      </div>
    </div>
  )
}

function PermissionBubble({
  b, approve, reject,
}: {
  b: Extract<LiveBubble, { kind: "permission" }>
  approve: (id: string) => void
  reject: (id: string) => void
}) {
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
            <Button size="sm" onClick={() => approve(b.invocationId)}>
              <Check className="w-4 h-4" /> 同意一次
            </Button>
            <Button size="sm" variant="outline" onClick={() => reject(b.invocationId)}>
              <X className="w-4 h-4" /> 拒绝
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function RunningIndicator() {
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-full bg-card border flex items-center justify-center">
        <Bot className="w-4 h-4 animate-pulse" />
      </div>
      <div className="text-xs text-muted-foreground flex items-center gap-2 pt-2">
        <span className="inline-block w-1 h-1 rounded-full bg-current animate-pulse" />
        <span className="inline-block w-1 h-1 rounded-full bg-current animate-pulse [animation-delay:200ms]" />
        <span className="inline-block w-1 h-1 rounded-full bg-current animate-pulse [animation-delay:400ms]" />
        正在思考…
      </div>
    </div>
  )
}

// ---------- Invocation list tab ----------

function InvocationList({ invocations }: { invocations: AIToolInvocation[] }) {
  if (invocations.length === 0) {
    return <div className="p-8 text-center text-sm text-muted-foreground">本会话还没有任何工具调用</div>
  }
  return (
    <div className="p-4 md:p-6 space-y-3">
      {invocations.slice().reverse().map((inv) => (
        <Card key={inv.id} className={cn("border-l-4",
          inv.status === "succeeded" ? "border-l-emerald-500" :
          inv.status === "failed" || inv.status === "rejected" ? "border-l-destructive" :
          inv.status === "dry_run" ? "border-l-zinc-400" :
          "border-l-amber-500"
        )}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <code className="font-mono">{inv.tool_name}</code>
                  <Badge variant="outline">{inv.status}</Badge>
                  <Badge variant="secondary">{inv.permission_mode}</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                  <Clock className="w-3 h-3" />
                  {fullTime(inv.created_at)} · {relTime(inv.created_at)}
                  {typeof inv.duration_ms === "number" && inv.duration_ms > 0 && (
                    <span>· {inv.duration_ms} ms</span>
                  )}
                  {inv.output_truncated && <span>· 输出已截断</span>}
                </div>
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">{inv.id}</div>
            </div>
            <div className="mt-3 space-y-2">
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">输入参数</summary>
                <pre className="mt-1 bg-zinc-950 text-zinc-100 p-2 rounded overflow-auto">{prettyJson(inv.input)}</pre>
              </details>
              {inv.output && (
                <details className="text-xs" open>
                  <summary className="cursor-pointer text-muted-foreground">输出 ({fmtBytes(inv.output.length)})</summary>
                  <div className="mt-1"><ToolOutputView raw={inv.output} /></div>
                </details>
              )}
              {inv.error && (
                <div className="text-xs text-destructive">错误：{inv.error}</div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

const DANGER_TOOLS = new Set(["ssh_exec", "sftp_write", "sftp_delete", "session_terminate", "portforward_create", "portforward_delete"])
function isDangerName(name: string): boolean { return DANGER_TOOLS.has(name) }

// keep icons we re-export
export { Trash2, Copy }
