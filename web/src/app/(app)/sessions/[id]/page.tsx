"use client"

import * as React from "react"
import { use } from "react"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { Download } from "lucide-react"
import { sessionService } from "@/lib/api/services"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { fmtBytes, fullTime } from "@/lib/format"

export default function SessionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  // The list endpoint includes the requested session; we filter client-side.
  const sessions = useQuery({ queryKey: ["sessions", "all"], queryFn: () => sessionService.list({ limit: 500 }) })
  const s = sessions.data?.sessions.find((x) => x.id === id)

  if (!s) {
    return <div className="p-6 text-sm text-muted-foreground">{sessions.isLoading ? "加载中…" : "会话不存在"}</div>
  }
  const isAsciinema = s.recording_type === "asciicast"
  const isGuac = s.recording_type === "guac"
  const url = sessionService.recordingURL(s.id)

  return (
    <div className="p-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{s.node_name || "—"} <span className="text-sm text-muted-foreground">{s.id}</span></CardTitle>
          <CardDescription className="flex gap-2 mt-1">
            <Badge variant="secondary">{s.kind}</Badge>
            <Badge variant={s.status === "closed" ? "outline" : "default"}>{s.status}</Badge>
            <span className="text-xs">{s.client_ip}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-6 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div><span className="text-muted-foreground">用户：</span>{s.username}</div>
          <div><span className="text-muted-foreground">开始：</span>{fullTime(s.started_at)}</div>
          <div><span className="text-muted-foreground">结束：</span>{fullTime(s.ended_at || undefined)}</div>
          <div><span className="text-muted-foreground">流量：</span>↑{fmtBytes(s.bytes_in)} ↓{fmtBytes(s.bytes_out)}</div>
          {s.reason && <div className="md:col-span-3"><span className="text-muted-foreground">错误：</span>{s.reason}</div>}
        </CardContent>
      </Card>

      {s.recording_path ? (
        <Card>
          <CardHeader>
            <CardTitle>会话录像</CardTitle>
            <CardDescription>
              {isAsciinema && "asciinema v2 文本回放"}
              {isGuac && "Guacamole 二进制录像（可用 guacenc 转 MP4）"}
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-6">
            {isAsciinema ? (
              <CastPlayer url={url} />
            ) : (
              <div className="space-y-2">
                <p className="text-sm">
                  二进制录像无法在浏览器内播放，请下载后用本地工具回放。
                </p>
                <Link
                  href={url as Parameters<typeof Link>[0]["href"]}
                  className="inline-flex items-center gap-1 px-3 h-9 rounded-md border hover:bg-accent text-sm"
                >
                  <Download className="w-4 h-4" /> 下载录像
                </Link>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="text-sm text-muted-foreground">本会话没有录像</div>
      )}
    </div>
  )
}

/** asciinema-player ESM 通过 dynamic import 加载，避免 SSR 报错。
 *  样式由 globals.css 的 @import "asciinema-player/...css" 提供。
 *  容器需要一个最小高度，否则 fit="width" 会塌成 0 px。
 */
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
    <div className="rounded-md overflow-hidden border bg-black">
      <div ref={ref} className="ap-host w-full min-h-[420px]" />
    </div>
  )
}
