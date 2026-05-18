"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import {
  Activity, Bot, Database, Heart, Monitor, Server, ShieldCheck, Sparkles, Terminal,
} from "lucide-react"
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  aiAgentService, aiConversationService, meService, sessionService,
} from "@/lib/api/services"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { relTime } from "@/lib/format"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/common/empty-state"
import type { NodeProtocol, Session } from "@/lib/api/types"

const PROTOCOL_ICON: Record<NodeProtocol, React.ComponentType<{ className?: string }>> = {
  ssh: Terminal,
  telnet: Terminal,
  rdp: Monitor,
  vnc: Monitor,
  mysql: Database,
  postgres: Database,
  redis: Database,
  mongo: Database,
  tcp: Server,
}

export default function DashboardPage() {
  const me = useCurrentUser()
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const recent = useQuery({ queryKey: ["me", "recent"], queryFn: () => meService.recentNodes(8) })
  const fav = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })
  const sessions = useQuery({ queryKey: ["sessions", "dashboard"], queryFn: () => sessionService.list({ limit: 200 }) })
  const agents = useQuery({ queryKey: ["ai", "agents"], queryFn: aiAgentService.list })
  const convs = useQuery({ queryKey: ["ai", "convs"], queryFn: aiConversationService.list })

  // 7-day session count for the chart.
  const chartData = React.useMemo(() => {
    const days: { label: string; date: string; count: number }[] = []
    const now = new Date()
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i)
      d.setHours(0, 0, 0, 0)
      const key = d.toISOString().slice(0, 10)
      days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, date: key, count: 0 })
    }
    for (const s of sessions.data?.sessions || []) {
      const key = (s.started_at || "").slice(0, 10)
      const slot = days.find((d) => d.date === key)
      if (slot) slot.count++
    }
    return days
  }, [sessions.data])

  // Top protocols pie / list.
  const protocolStats = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const n of nodes.data?.nodes || []) {
      m.set(n.protocol, (m.get(n.protocol) || 0) + 1)
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [nodes.data])

  // Pending approval queue across all conversations.
  const pendingInvocations = React.useMemo(() => {
    // We don't have a backend endpoint for "all pending across me", so the
    // dashboard surfaces this via the count of "running" conversations only.
    return (convs.data?.conversations || []).filter((c) => c.status === "running")
  }, [convs.data])

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">你好，{me?.usr || "访客"}</h1>
          <p className="text-sm text-muted-foreground mt-1">欢迎回到 JumpServer Anonymous，这里是你的运维总览。</p>
        </div>
        {pendingInvocations.length > 0 && (
          <Link
            href={"/ai" as Parameters<typeof Link>[0]["href"]}
            className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            有 {pendingInvocations.length} 个 AI 对话正在运行
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Server} label="可见节点" value={nodes.data?.nodes.length ?? "-"} hint={nodes.data?.scope === "all" ? "全部资产" : "已授权资产"} />
        <StatCard icon={Activity} label="近 7 天会话" value={chartData.reduce((a, b) => a + b.count, 0)} />
        <StatCard icon={Heart} label="收藏节点" value={fav.data?.node_ids.length ?? "-"} />
        <StatCard icon={Bot} label="可用 Agent" value={agents.data?.agents.length ?? "-"} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="w-5 h-5" /> 会话趋势</CardTitle>
            <CardDescription>过去 7 天的会话数</CardDescription>
          </CardHeader>
          <CardContent className="pb-6">
            {sessions.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={200} minWidth={0}>
                <BarChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="currentColor" opacity={0.5} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} stroke="currentColor" opacity={0.5} width={28} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-popover)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5" /> 协议分布</CardTitle>
            <CardDescription>当前可见资产</CardDescription>
          </CardHeader>
          <CardContent className="pb-6">
            {protocolStats.length === 0 ? (
              <div className="text-sm text-muted-foreground">没有数据</div>
            ) : (
              <div className="space-y-2">
                {protocolStats.map(([proto, n]) => {
                  const Icon = (PROTOCOL_ICON as Record<string, React.ComponentType<{ className?: string }>>)[proto] || Server
                  const total = nodes.data?.nodes.length || 1
                  return (
                    <div key={proto} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5">
                          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                          {proto.toUpperCase()}
                        </span>
                        <span className="text-muted-foreground">{n}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${(n / total) * 100}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="w-5 h-5" /> 最近的会话</CardTitle>
            <CardDescription>SSH / Telnet / RDP / VNC / DB CLI</CardDescription>
          </CardHeader>
          <CardContent className="pb-6">
            <RecentSessions sessions={(sessions.data?.sessions || []).slice(0, 8)} loading={sessions.isLoading} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Sparkles className="w-5 h-5" /> 推荐 Agent</CardTitle>
            <CardDescription>点开始一段运维对话</CardDescription>
          </CardHeader>
          <CardContent className="pb-6">
            {agents.isLoading ? (
              <ListSkeleton />
            ) : (agents.data?.agents?.length ?? 0) === 0 ? (
              <EmptyState
                icon={Bot}
                title="没有可用 Agent"
                description="管理员可在 AI Agent 中创建"
              />
            ) : (
              <ul className="space-y-2">
                {agents.data!.agents.slice(0, 6).map((a) => (
                  <li key={a.id}>
                    <Link
                      href={"/ai" as Parameters<typeof Link>[0]["href"]}
                      className="block rounded p-2 hover:bg-accent text-sm"
                    >
                      <div className="font-medium flex items-center gap-2">
                        <Bot className="w-4 h-4" />
                        {a.name}
                        <Badge variant="outline" className="text-[10px]">{a.scope}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{a.description}</div>
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
          <CardTitle className="flex items-center gap-2"><Server className="w-5 h-5" /> 我的节点</CardTitle>
          <CardDescription>按资产授权过滤后的可访问节点 · 最近使用 {recent.data?.recent.length ?? 0} 个</CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          {nodes.isLoading ? (
            <ListSkeleton />
          ) : (nodes.data?.nodes?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Server}
              title="还没有被授权访问任何节点"
              description="请联系管理员通过「资产授权」开放访问"
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {nodes.data!.nodes.slice(0, 9).map((n) => {
                const Icon = PROTOCOL_ICON[n.protocol] || Server
                return (
                  <Link
                    key={n.id}
                    href={`/nodes/${n.id}` as Parameters<typeof Link>[0]["href"]}
                    className="rounded-lg border p-3 hover:bg-accent hover:border-primary/40 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm flex items-center gap-1.5">
                        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                        {n.name}
                      </div>
                      <Badge variant="outline" className="text-[10px]">{n.protocol}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 font-mono">{n.host}:{n.port}</div>
                  </Link>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RecentSessions({ sessions, loading }: { sessions: Session[]; loading: boolean }) {
  if (loading) return <ListSkeleton />
  if (sessions.length === 0) return <div className="text-sm text-muted-foreground py-2">还没有会话记录</div>
  return (
    <ul className="divide-y">
      {sessions.map((s) => (
        <li key={s.id} className="py-2.5 flex items-center justify-between">
          <Link
            href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}
            className="flex-1 min-w-0 group"
          >
            <div className="font-medium text-sm group-hover:underline truncate">{s.node_name || s.id}</div>
            <div className="text-xs text-muted-foreground">
              {s.kind} · {s.status} · {relTime(s.started_at)}
            </div>
          </Link>
          <Badge variant={s.status === "errored" ? "destructive" : s.status === "active" ? "success" : "outline"} className="ml-2">
            {s.status}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

function StatCard({
  icon: Icon, label, value, hint,
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
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
    </div>
  )
}
