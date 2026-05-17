"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Activity, Bot, Heart, Server, ShieldCheck, Sparkles } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { meService, sessionService, aiAgentService } from "@/lib/api/services"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { relTime } from "@/lib/format"
import { Skeleton } from "@/components/ui/skeleton"

export default function DashboardPage() {
  const me = useCurrentUser()
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const recent = useQuery({ queryKey: ["me", "recent"], queryFn: () => meService.recentNodes(8) })
  const fav = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })
  const sessions = useQuery({ queryKey: ["sessions", "recent"], queryFn: () => sessionService.list({ limit: 8 }) })
  const agents = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">你好，{me?.usr || "访客"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            欢迎回到 JumpServer Anonymous。这里是你的运维总览。
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Server} label="可见节点" value={nodes.data?.nodes.length ?? "-"} hint={nodes.data?.scope === "all" ? "全部资产" : "已授权资产"} />
        <StatCard icon={Activity} label="最近会话" value={sessions.data?.sessions.length ?? "-"} />
        <StatCard icon={Heart} label="收藏节点" value={fav.data?.node_ids.length ?? "-"} />
        <StatCard icon={Bot} label="可用 Agent" value={agents.data?.agents.length ?? "-"} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5" /> 最近的会话
            </CardTitle>
            <CardDescription>历史 SSH / Telnet / RDP / VNC / DB CLI 会话</CardDescription>
          </CardHeader>
          <CardContent className="pb-6">
            {sessions.isLoading ? (
              <ListSkeleton />
            ) : (sessions.data?.sessions?.length ?? 0) === 0 ? (
              <div className="text-sm text-muted-foreground">还没有会话记录</div>
            ) : (
              <ul className="divide-y">
                {sessions.data!.sessions.map((s) => (
                  <li key={s.id} className="py-3 flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">{s.node_name || s.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.kind} · {s.status} · {relTime(s.started_at)}
                      </div>
                    </div>
                    <Link
                      href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}
                      className="text-xs text-primary hover:underline"
                    >
                      查看
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5" /> 推荐 Agent
            </CardTitle>
            <CardDescription>点开始一段运维对话</CardDescription>
          </CardHeader>
          <CardContent className="pb-6">
            {agents.isLoading ? (
              <ListSkeleton />
            ) : (agents.data?.agents?.length ?? 0) === 0 ? (
              <div className="text-sm text-muted-foreground">
                <ShieldCheck className="w-4 h-4 inline mr-1" />
                管理员还没有配置 Agent
              </div>
            ) : (
              <ul className="space-y-2">
                {agents.data!.agents.slice(0, 6).map((a) => (
                  <li key={a.id} className="text-sm">
                    <Link
                      href={"/ai" as Parameters<typeof Link>[0]["href"]}
                      className="hover:underline flex items-center gap-2"
                    >
                      <Bot className="w-4 h-4" />
                      <span className="font-medium">{a.name}</span>
                      <span className="text-xs text-muted-foreground truncate">{a.description}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="w-5 h-5" /> 我的节点
          </CardTitle>
          <CardDescription>按资产授权过滤后的可访问节点</CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          {nodes.isLoading ? (
            <ListSkeleton />
          ) : (nodes.data?.nodes?.length ?? 0) === 0 ? (
            <div className="text-sm text-muted-foreground">还没有被授权访问任何节点</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {nodes.data!.nodes.slice(0, 9).map((n) => (
                <Link
                  key={n.id}
                  href={`/nodes/${n.id}` as Parameters<typeof Link>[0]["href"]}
                  className="rounded-lg border p-3 hover:bg-accent transition-colors"
                >
                  <div className="font-medium text-sm">{n.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {n.protocol.toUpperCase()} · {n.host}:{n.port}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <Card>
      <CardContent className="pt-6 pb-6">
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">{label}</div>
          <Icon className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="mt-2 text-2xl font-semibold">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}
