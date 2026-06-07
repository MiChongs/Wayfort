"use client"

import * as React from "react"
import { use } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { toast } from "@/components/ui/sonner"
import {
  ArrowLeft,
  Clapperboard,
  Download,
  ListTree,
  Power,
  Terminal as TerminalIcon,
  Upload,
} from "lucide-react"
import { sessionService } from "@/lib/api/services"
import type { AuditEvent } from "@/lib/api/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { DesktopRecordingPlayer } from "@/components/desktop/desktop-recording-player"
import { useAccess } from "@/lib/hooks/use-access"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { auditMeta, kindMeta, statusMeta, fmtDuration } from "@/lib/session-meta"
import { cn } from "@/lib/utils"

export default function SessionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const access = useAccess()
  const canTerminate = access.isSuperadmin || access.permissions.includes("session:terminate")

  const sq = useQuery({ queryKey: ["session", id], queryFn: () => sessionService.get(id) })
  const s = sq.data?.session

  const audit = useQuery({
    queryKey: ["session", id, "audit"],
    queryFn: () => sessionService.audit(id),
    enabled: !!s,
    refetchInterval: s?.status === "active" ? 5000 : false,
  })

  if (sq.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">载入会话…</div>
  }
  if (!s) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <EmptyState
          icon={ListTree}
          title="找不到这个会话"
          description="它可能已被清理，或链接有误。"
          action={<Link href="/sessions"><Button variant="outline" size="sm"><ArrowLeft className="h-4 w-4" /> 返回会话列表</Button></Link>}
        />
      </div>
    )
  }

  const km = kindMeta(s.kind)
  const sm = statusMeta(s.status)
  const KindIcon = km.icon
  const isActive = s.status === "active"
  const url = sessionService.recordingURL(s.id)

  async function terminate() {
    if (!s) return
    const ok = await confirmDialog({
      title: "强制下线该会话？",
      description: (
        <>
          将立即断开 <b>{s.username}</b> 在 <b>{s.node_name || "目标"}</b> 上的{km.label}，此操作记入审计。
        </>
      ),
      confirmLabel: "强制下线",
      destructive: true,
    })
    if (!ok) return
    try {
      await sessionService.terminate(s.id)
      toast.success("会话已下线")
      sq.refetch()
      audit.refetch()
    } catch (e) {
      toast.error((e as { message?: string }).message || "下线失败")
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-6">
      <div>
        <Link href="/sessions" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> 会话列表
        </Link>
      </div>

      {/* Hero */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
              <KindIcon className="h-5 w-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold">{s.node_name || "匿名目标"}</h1>
                <Badge variant={sm.tone}>{sm.label}</Badge>
                <Badge variant="soft">{km.label}</Badge>
              </div>
              <div className="mt-1 flex items-center gap-1 font-mono text-xs text-muted-foreground">
                {s.id}
                <CopyButton value={s.id} size="icon" className="h-5 w-5" />
              </div>
            </div>
          </div>
          {isActive && canTerminate && (
            <Button variant="destructive" size="sm" onClick={terminate}>
              <Power className="h-4 w-4" /> 强制下线
            </Button>
          )}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">
          <Field label="用户" value={s.username} />
          <Field label="来源 IP" value={s.client_ip || "—"} mono />
          <Field label="时长" value={fmtDuration(s.started_at, isActive ? null : s.ended_at)} />
          <Field label="流量" value={`↑${fmtBytes(s.bytes_in)} ↓${fmtBytes(s.bytes_out)}`} />
          <Field label="开始" value={fullTime(s.started_at)} hint={relTime(s.started_at)} />
          <Field label="结束" value={s.ended_at ? fullTime(s.ended_at) : isActive ? "进行中" : "—"} />
          {s.reason && <Field label="结束原因" value={s.reason} className="col-span-2 sm:col-span-3 lg:col-span-4" />}
        </dl>
      </div>

      {/* Recording */}
      <Recording session={s} url={url} />

      {/* Audit timeline */}
      <Timeline events={audit.data?.events ?? []} loading={audit.isLoading} live={isActive} />
    </div>
  )
}

function Field({
  label, value, hint, mono, className,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  mono?: boolean
  className?: string
}) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words", mono && "font-mono text-xs")}>{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  )
}

function Recording({ session, url }: { session: { recording_path?: string; recording_type?: string }; url: string }) {
  const hasRec = !!session.recording_path
  const type = session.recording_type
  if (!hasRec) {
    return (
      <div className="rounded-xl border border-dashed bg-card/40 p-6 text-center text-sm text-muted-foreground">
        本次会话没有录像
      </div>
    )
  }
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Clapperboard className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">会话录像</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {type === "asciicast" && "终端文本回放"}
          {type === "desktop" && "桌面录像 · 浏览器内回放"}
          {type === "guac" && "Guacamole 录像"}
        </span>
      </div>
      <div className="p-4">
        {type === "asciicast" ? (
          <CastPlayer url={url} />
        ) : type === "desktop" ? (
          <DesktopRecordingPlayer url={url} />
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">
              这种二进制录像无法在浏览器内直接播放，下载后用本地工具回放。
            </p>
            <Link
              href={url as Parameters<typeof Link>[0]["href"]}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm hover:bg-accent"
            >
              <Download className="h-4 w-4" /> 下载录像
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

type TimelineFilter = "all" | "command" | "file" | "lifecycle"

function Timeline({ events, loading, live }: { events: AuditEvent[]; loading: boolean; live: boolean }) {
  const [filter, setFilter] = React.useState<TimelineFilter>("all")

  const counts = React.useMemo(() => {
    const c = { all: events.length, command: 0, file: 0, lifecycle: 0 }
    for (const e of events) c[auditMeta(e.kind).group]++
    return c
  }, [events])

  const shown = React.useMemo(
    () => (filter === "all" ? events : events.filter((e) => auditMeta(e.kind).group === filter)),
    [events, filter],
  )

  const chips: { key: TimelineFilter; label: string; icon?: React.ComponentType<{ className?: string }> }[] = [
    { key: "all", label: "全部" },
    { key: "command", label: "命令", icon: TerminalIcon },
    { key: "file", label: "文件", icon: Upload },
    { key: "lifecycle", label: "事件", icon: ListTree },
  ]

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <ListTree className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">操作审计</span>
        {live && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            实时
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {chips.map((c) => {
            const n = counts[c.key]
            const Icon = c.icon
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setFilter(c.key)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                  filter === c.key ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {Icon && <Icon className="h-3 w-3" />}
                {c.label}
                <span className="tabular-nums opacity-70">{n}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="p-2">
        {loading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={TerminalIcon}
            title={filter === "command" ? "没有捕获到命令" : "暂无审计记录"}
            description={
              filter === "command"
                ? "图形 / 转发类会话不产生命令；终端命令会在输入回车后逐条记录。"
                : "这次会话没有产生此类操作。"
            }
          />
        ) : (
          <ol className="relative space-y-0.5">
            {shown.map((e) => (
              <TimelineRow key={e.id} e={e} />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function TimelineRow({ e }: { e: AuditEvent }) {
  const m = auditMeta(e.kind)
  const Icon = m.icon
  const detail = renderPayload(e)
  return (
    <li className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-accent/30">
      <span
        className={cn(
          "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md",
          m.group === "command"
            ? "bg-primary/12 text-primary"
            : m.group === "file"
              ? "bg-sky-500/12 text-sky-600 dark:text-sky-400"
              : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {m.group === "command" ? (
          <code className="block break-all rounded bg-muted/60 px-2 py-1 font-mono text-[13px] text-foreground">
            {e.payload || ""}
          </code>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm">{m.label}</span>
            {detail && <span className="break-all font-mono text-xs text-muted-foreground">{detail}</span>}
          </div>
        )}
      </div>
      <time className="shrink-0 text-xs tabular-nums text-muted-foreground" title={fullTime(e.created_at)}>
        {timeOnly(e.created_at)}
      </time>
    </li>
  )
}

function timeOnly(iso?: string): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false })
  } catch {
    return ""
  }
}

// renderPayload pulls the human-meaningful bit out of an audit payload — for
// file/oss events that's the path; everything else shows the raw payload.
function renderPayload(e: AuditEvent): string {
  const p = e.payload || ""
  if (!p) return ""
  if (e.kind.startsWith("file.") || e.kind.startsWith("oss.")) {
    // payloads look like "<path> bytes=123" or "<from> -> <to>"
    const m = p.match(/bytes=(\d+)/)
    const path = p.replace(/\s*bytes=\d+\s*$/, "")
    if (m) return `${path} · ${fmtBytes(Number(m[1]))}`
    return path
  }
  return p
}

/** asciinema-player loaded via dynamic import to avoid SSR issues. Styles come
 *  from globals.css's @import. The host needs a min-height or fit="width"
 *  collapses to 0. */
function CastPlayer({ url }: { url: string }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    let disposed = false
    let inst: { dispose?: () => void } | null = null
    ;(async () => {
      try {
        const player = await import("asciinema-player")
        if (disposed || !ref.current) return
        inst = player.create(url, ref.current, {
          fit: "width",
          theme: "monokai",
          autoPlay: false,
          preload: true,
          terminalFontSize: "14px",
          idleTimeLimit: 2,
        })
      } catch (e) {
        if (ref.current) ref.current.textContent = "录像播放器加载失败：" + String(e)
      }
    })()
    return () => {
      disposed = true
      inst?.dispose?.()
    }
  }, [url])
  return (
    <div className="overflow-hidden rounded-md border bg-black">
      <div ref={ref} className="ap-host min-h-[420px] w-full" />
    </div>
  )
}
