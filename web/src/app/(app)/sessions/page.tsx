"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Activity, Filter, Play, RefreshCw, Search } from "lucide-react"
import { sessionService } from "@/lib/api/services"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import type { Session } from "@/lib/api/types"
import { EmptyState } from "@/components/common/empty-state"

const PAGE_SIZE = 50

export default function SessionsPage() {
  const [status, setStatus] = React.useState<string>("")
  const [kind, setKind] = React.useState<string>("")
  const [q, setQ] = React.useState("")
  const [page, setPage] = React.useState(0)

  const sessions = useQuery({
    queryKey: ["sessions", "all", status, page],
    queryFn: () => sessionService.list({
      status: status || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
  })

  const filtered = React.useMemo(() => {
    let rows = sessions.data?.sessions || []
    if (kind) rows = rows.filter((s) => s.kind === kind)
    if (q) {
      const needle = q.toLowerCase()
      rows = rows.filter((s) =>
        [s.id, s.node_name || "", s.username, s.client_ip || ""].some((v) => v.toLowerCase().includes(needle))
      )
    }
    return rows
  }, [sessions.data, kind, q])

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Activity className="w-5 h-5" /> 会话历史
          </h1>
          <p className="text-sm text-muted-foreground mt-1">所有 SSH / Telnet / 图形 / DB CLI 会话，含录像回放。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => sessions.refetch()}>
          <RefreshCw className="w-4 h-4" /> 刷新
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative w-72 max-w-full">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 节点 / 用户 / IP / session id"
            className="pl-8"
          />
        </div>
        <Select value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setPage(0) }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">active</SelectItem>
            <SelectItem value="closed">closed</SelectItem>
            <SelectItem value="errored">errored</SelectItem>
            <SelectItem value="terminated">terminated</SelectItem>
          </SelectContent>
        </Select>
        <Select value={kind || "all"} onValueChange={(v) => setKind(v === "all" ? "" : v)}>
          <SelectTrigger className="w-44"><SelectValue placeholder="类型" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="interactive">interactive</SelectItem>
            <SelectItem value="graphical">graphical</SelectItem>
            <SelectItem value="anonymous">anonymous</SelectItem>
            <SelectItem value="tcp_forward">tcp_forward</SelectItem>
            <SelectItem value="sftp">sftp</SelectItem>
          </SelectContent>
        </Select>
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Filter className="w-3 h-3" /> 共 {sessions.data?.sessions?.length ?? 0} 条 (本页)
        </div>
      </div>

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2">节点</th>
              <th className="text-left px-3 py-2">用户</th>
              <th className="text-left px-3 py-2">类型</th>
              <th className="text-left px-3 py-2 hidden md:table-cell">客户端 IP</th>
              <th className="text-left px-3 py-2 hidden lg:table-cell">流量</th>
              <th className="text-left px-3 py-2">开始</th>
              <th className="text-left px-3 py-2">状态</th>
              <th className="text-right px-3 py-2">回放</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s: Session) => (
              <tr key={s.id} className="border-t hover:bg-accent/30">
                <td className="px-3 py-2">
                  <Link
                    href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}
                    className="font-medium hover:underline"
                  >
                    {s.node_name || "—"}
                  </Link>
                  <div className="text-xs text-muted-foreground font-mono">{s.id.slice(0, 12)}…</div>
                </td>
                <td className="px-3 py-2 text-xs">{s.username}</td>
                <td className="px-3 py-2">
                  <Badge variant="secondary">{s.kind}</Badge>
                </td>
                <td className="px-3 py-2 hidden md:table-cell font-mono text-xs">{s.client_ip || "—"}</td>
                <td className="px-3 py-2 hidden lg:table-cell text-xs text-muted-foreground">
                  ↑{fmtBytes(s.bytes_in)} ↓{fmtBytes(s.bytes_out)}
                </td>
                <td className="px-3 py-2 text-xs">
                  <div>{fullTime(s.started_at)}</div>
                  <div className="text-muted-foreground">{relTime(s.started_at)}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      s.status === "closed" ? "outline" :
                      s.status === "errored" || s.status === "terminated" ? "destructive" : "success"
                    }
                  >
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
              <tr><td colSpan={8} className="text-center text-muted-foreground py-8">加载中…</td></tr>
            )}
            {!sessions.isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-2">
                  <EmptyState
                    icon={Activity}
                    title="没有匹配的会话"
                    description={q || status || kind ? "试试调整搜索条件或筛选" : "你还没有打开过任何节点会话"}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-end gap-2 text-sm">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          上一页
        </Button>
        <span className="text-xs text-muted-foreground">第 {page + 1} 页</span>
        <Button
          variant="outline" size="sm"
          disabled={(sessions.data?.sessions?.length ?? 0) < PAGE_SIZE}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  )
}
