"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink, Loader2, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { fullTime, relTime } from "@/lib/format"
import { sessionService } from "@/lib/api/services"

type Props = {
  nodeId: number
}

// SessionsTab — recent sessions filtered server-side by node_id. Backed by
// the workspace v2 addition of `node_id` to the /sessions handler so we
// don't fetch all sessions then filter client-side.
export function SessionsTab({ nodeId }: Props) {
  const list = useQuery({
    queryKey: ["sessions", "node", nodeId],
    queryFn: () => sessionService.list({ node_id: nodeId, limit: 50 }),
    refetchInterval: 30_000,
  })
  const rows = list.data?.sessions ?? []

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-3 py-2 border-b text-xs">
        <span className="font-medium">本节点最近会话</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void list.refetch()}
        >
          <RefreshCw className={`w-3 h-3 ${list.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </header>

      <div className="flex-1 overflow-auto">
        {list.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        )}
        {!list.isLoading && rows.length === 0 && (
          <div className="text-sm text-muted-foreground p-6 text-center">本节点尚无会话记录</div>
        )}
        {rows.length > 0 && (
          <table className="w-full text-xs">
            <thead className="bg-muted/50 sticky top-0 text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-2 py-1.5">用户</th>
                <th className="text-left px-2 py-1.5">类型</th>
                <th className="text-left px-2 py-1.5">开始</th>
                <th className="text-left px-2 py-1.5">状态</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((s) => (
                <tr key={s.id} className="hover:bg-accent/40">
                  <td className="px-2 py-1.5 truncate max-w-[7rem]" title={s.username}>
                    {s.username}
                  </td>
                  <td className="px-2 py-1.5 uppercase">{s.kind}</td>
                  <td className="px-2 py-1.5">
                    <div>{fullTime(s.started_at)}</div>
                    <div className="text-[10px] text-muted-foreground">{relTime(s.started_at)}</div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    <Link
                      href={`/sessions/${s.id}` as any}
                      className="text-muted-foreground hover:text-foreground inline-flex"
                      title="查看会话详情"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function statusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "active":
      return "default"
    case "closed":
      return "secondary"
    case "errored":
    case "terminated":
      return "destructive"
    default:
      return "outline"
  }
}
