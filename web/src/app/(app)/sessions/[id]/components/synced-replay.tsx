"use client"

import * as React from "react"
import Link from "next/link"
import { Clapperboard, Download } from "lucide-react"
import type { AuditEvent, Session } from "@/lib/api/types"
import { DesktopRecordingPlayer } from "@/components/desktop/desktop-recording-player"
import type { ReplayController } from "@/lib/viz/replay-sync"
import { CastPlayer } from "./cast-player"
import { SyncedTimeline } from "./synced-timeline"

// SyncedReplay binds the session recording to its audit timeline. For terminal
// (asciicast) recordings the two share a clock — playback highlights the active
// audit row and clicking a row seeks the player. Desktop keeps its own in-player
// .dtr timeline (already synced) with the searchable audit list beneath; guac /
// no-recording fall back to a static timeline.
export function SyncedReplay({
  session,
  events,
  url,
  live,
  loading,
}: {
  session: Session
  events: AuditEvent[]
  url: string
  live: boolean
  loading?: boolean
}) {
  const [controller, setController] = React.useState<ReplayController | null>(null)
  const type = session.recording_type
  const hasRec = !!session.recording_path
  const durationMs =
    (session.ended_at ? new Date(session.ended_at).getTime() : Date.now()) -
    new Date(session.started_at).getTime()

  if (type === "asciicast" && hasRec) {
    return (
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-xl border bg-card">
          <Header label="终端文本回放 · 与审计同步" />
          <div className="p-4">
            <CastPlayer
              url={url}
              events={events}
              sessionStart={session.started_at}
              sessionDurationMs={durationMs}
              onController={setController}
            />
          </div>
        </div>
        <div className="min-h-[480px]">
          <SyncedTimeline
            events={events}
            loading={loading}
            live={live}
            sessionStart={session.started_at}
            sessionDurationMs={durationMs}
            controller={controller}
          />
        </div>
      </div>
    )
  }

  if (type === "desktop" && hasRec) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border bg-card">
          <Header label="桌面录像 · 浏览器内回放" />
          <div className="p-4">
            <DesktopRecordingPlayer url={url} />
          </div>
        </div>
        <SyncedTimeline
          events={events}
          loading={loading}
          live={live}
          sessionStart={session.started_at}
          sessionDurationMs={durationMs}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {hasRec ? (
        <div className="rounded-xl border bg-card">
          <Header label="Guacamole 录像" />
          <div className="flex flex-col items-start gap-2 p-4">
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
        </div>
      ) : (
        <div className="rounded-xl border border-dashed bg-card/40 p-6 text-center text-sm text-muted-foreground">
          本次会话没有录像
        </div>
      )}
      <SyncedTimeline
        events={events}
        loading={loading}
        live={live}
        sessionStart={session.started_at}
        sessionDurationMs={durationMs}
      />
    </div>
  )
}

function Header({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <Clapperboard className="h-4 w-4 text-primary" />
      <span className="text-sm font-medium">会话录像</span>
      <span className="ml-auto text-xs text-muted-foreground">{label}</span>
    </div>
  )
}
