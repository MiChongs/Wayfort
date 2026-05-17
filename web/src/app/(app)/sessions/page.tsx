"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Activity, Download, Play } from "lucide-react"
import { sessionService } from "@/lib/api/services"
import { Badge } from "@/components/ui/badge"
import { fmtBytes, fullTime, relTime } from "@/lib/format"

export default function SessionsPage() {
  const sessions = useQuery({ queryKey: ["sessions", "all"], queryFn: () => sessionService.list({ limit: 200 }) })

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Activity className="w-5 h-5" /> 会话历史
        </h1>
        <p className="text-sm text-muted-foreground mt-1">所有 SSH / Telnet / 图形 / DB CLI 会话，含录像回放。</p>
      </div>
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">节点</th>
              <th className="text-left px-3 py-2">类型</th>
              <th className="text-left px-3 py-2 hidden md:table-cell">客户端 IP</th>
              <th className="text-left px-3 py-2 hidden lg:table-cell">流量</th>
              <th className="text-left px-3 py-2">开始</th>
              <th className="text-left px-3 py-2">状态</th>
              <th className="text-right px-3 py-2">回放</th>
            </tr>
          </thead>
          <tbody>
            {(sessions.data?.sessions || []).map((s) => (
              <tr key={s.id} className="border-t hover:bg-accent/30">
                <td className="px-3 py-2">
                  <Link
                    href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}
                    className="font-medium hover:underline"
                  >
                    {s.node_name || "—"}
                  </Link>
                  <div className="text-xs text-muted-foreground">{s.id}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge variant="secondary">{s.kind}</Badge>
                </td>
                <td className="px-3 py-2 hidden md:table-cell">{s.client_ip || "—"}</td>
                <td className="px-3 py-2 hidden lg:table-cell text-xs text-muted-foreground">
                  ↑{fmtBytes(s.bytes_in)} ↓{fmtBytes(s.bytes_out)}
                </td>
                <td className="px-3 py-2 text-xs">
                  <div>{fullTime(s.started_at)}</div>
                  <div className="text-muted-foreground">{relTime(s.started_at)}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge variant={s.status === "closed" ? "outline" : s.status === "errored" ? "destructive" : "success"}>
                    {s.status}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {s.recording_path ? (
                    <Link
                      href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-accent text-primary"
                    >
                      <Play className="w-4 h-4" /> 回放
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">无录像</span>
                  )}
                </td>
              </tr>
            ))}
            {sessions.isLoading && (
              <tr><td colSpan={7} className="text-center text-muted-foreground py-8">加载中…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
// avoid tree-shake warning on Download icon
export { Download }
