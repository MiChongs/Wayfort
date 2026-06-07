"use client"

import * as React from "react"
import { use } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight, FolderOpen, Heart, LayoutGrid, Monitor, Play,
  Share2, Table as TableIcon, Terminal as TerminalIcon,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Pencil } from "lucide-react"
import { meService, nodeService, sessionService } from "@/lib/api/services"
import { CopyButton } from "@/components/common/copy-button"
import { TagBadge } from "@/components/tags/tag-badge"
import { AppIcon } from "@/components/icons/app-icon"
import { nodeIcon } from "@/lib/icons/protocol"
import { useAccess } from "@/lib/hooks/use-access"
import { fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useWorkspaceStore, type Protocol } from "@/components/workspace/useWorkspaceStore"

export default function NodeDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const qc = useQueryClient()
  const { isAdmin } = useAccess()

  const node = useQuery({ queryKey: ["node", nodeId], queryFn: () => nodeService.get(nodeId) })
  const fav = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })
  const sessions = useQuery({ queryKey: ["sessions", "node", nodeId], queryFn: () => sessionService.list({ limit: 200 }) })

  const toggleFav = useMutation({
    mutationFn: async ({ current }: { current: boolean }) =>
      current ? meService.removeFavorite(nodeId) : meService.addFavorite(nodeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "favorites"] }),
    onError: (e: unknown) => toast.error("操作失败", { description: (e as Error).message }),
  })

  if (node.isLoading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>
  if (!node.data) return <div className="p-6 text-sm text-muted-foreground">节点不存在</div>

  const n = node.data
  const isFav = (fav.data?.node_ids || []).includes(nodeId)
  const recentNodeSessions = (sessions.data?.sessions || []).filter((s) => s.node_id === nodeId).slice(0, 10)
  const actions = actionList(n.protocol)

  const managedTags = n.tag_list || []
  const freetextTags = (n.tags || "").split(",").map((t) => t.trim()).filter(Boolean)

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle className="flex items-center gap-2">
              <AppIcon icon={nodeIcon(n)} size={20} />
              {n.name}
              {n.disabled && <Badge variant="destructive">已禁用</Badge>}
            </CardTitle>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={"/admin/nodes" as Parameters<typeof Link>[0]["href"]}>
                    <Pencil className="h-4 w-4" /> 编辑
                  </Link>
                </Button>
              )}
              <Button
                variant={isFav ? "secondary" : "outline"}
                size="sm"
                onClick={() => toggleFav.mutate({ current: isFav })}
              >
                <Heart className={cn("w-4 h-4", isFav && "fill-current text-red-500")} />
                {isFav ? "已收藏" : "收藏"}
              </Button>
            </div>
          </div>
          <CardDescription className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary">{n.protocol.toUpperCase()}</Badge>
            <span className="font-mono text-xs">
              {n.host}:{n.port}
              <CopyButton value={`${n.host}:${n.port}`} className="ml-1 h-6 w-6" />
            </span>
            {n.region && <Badge variant="outline">{n.region}</Badge>}
            {managedTags.length > 0
              ? managedTags.map((t) => <TagBadge key={t.id} tag={t} size="sm" showDot />)
              : freetextTags.map((t) => <Badge key={t} variant="outline">#{t}</Badge>)}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-6 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <Field label="用户名" value={n.username || "—"} />
          <Field label="凭据" value={n.credential_name || (n.credential_id ? `#${n.credential_id}` : "—")} />
          <Field
            label="代理链"
            value={n.proxy_names && n.proxy_names.length ? n.proxy_names.join(" → ") : n.proxy_chain || "直连"}
          />
          <Field
            label="访问控制"
            value={
              n.requires_approval_for_connect || n.requires_approval_for_file_xfer ? (
                <span className="flex flex-wrap gap-1.5">
                  {n.requires_approval_for_connect && (
                    <Badge variant="warning" className="font-normal">连接需审批</Badge>
                  )}
                  {n.requires_approval_for_file_xfer && (
                    <Badge variant="warning" className="font-normal">文件传输需审批</Badge>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">无需审批</span>
              )
            }
          />
          {n.proto_options && (
            <div className="md:col-span-2">
              <Field label="协议参数" value={<pre className="text-xs font-mono bg-muted p-2 rounded overflow-auto">{prettyJson(n.proto_options)}</pre>} />
            </div>
          )}
          {n.description && <div className="md:col-span-2"><Field label="描述" value={n.description} /></div>}
        </CardContent>
      </Card>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium text-muted-foreground">动作</div>
          <Button
            variant="outline"
            size="sm"
            asChild
          >
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <Link href={"/workspace" as any} className="gap-1.5">
              <LayoutGrid className="w-3.5 h-3.5" />
              切换到工作台
            </Link>
          </Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {actions.map((a) => (
            <ActionCard
              key={a.href}
              action={a}
              node={n}
              nodeId={nodeId}
            />
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近会话</CardTitle>
          <CardDescription>此节点上的最近 10 条记录</CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          {recentNodeSessions.length === 0 ? (
            <div className="text-sm text-muted-foreground">还没有会话历史</div>
          ) : (
            <ul className="divide-y">
              {recentNodeSessions.map((s) => (
                <li key={s.id} className="py-2 flex items-center justify-between">
                  <Link href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]} className="flex-1 min-w-0 group">
                    <div className="font-mono text-xs truncate group-hover:underline">{s.id}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.username} · {s.kind} · {relTime(s.started_at)} · {fullTime(s.started_at)}
                    </div>
                  </Link>
                  <Badge variant={s.status === "errored" ? "destructive" : s.status === "active" ? "success" : "outline"} className="ml-2">
                    {s.status}
                  </Badge>
                  {s.recording_path && (
                    <Link
                      href={`/sessions/${s.id}` as Parameters<typeof Link>[0]["href"]}
                      className="ml-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <Play className="w-3 h-3" /> 回放
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-all">{value}</div>
    </div>
  )
}

function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

type ActionItem = {
  href: string
  label: string
  hint: string
  icon: React.ComponentType<{ className?: string }>
  external?: boolean
  // When present, the card's primary CTA opens a workspace tab instead of
  // navigating to the standalone page. The standalone page remains a
  // secondary link on the card.
  protocol?: Protocol
}

function actionList(protocol: string): ActionItem[] {
  const out: ActionItem[] = []
  if (protocol === "ssh") {
    out.push({ href: "/ssh", label: "SSH 终端", hint: "浏览器内 xterm.js", icon: TerminalIcon, protocol: "ssh" })
    out.push({ href: "/sftp", label: "SFTP 文件管理", hint: "上传 / 下载 / 编辑", icon: FolderOpen, protocol: "sftp" })
  } else if (protocol === "telnet") {
    out.push({ href: "/telnet", label: "Telnet 终端", hint: "适合网络设备", icon: TerminalIcon, protocol: "telnet" })
  } else if (protocol === "rdp") {
    out.push({ href: "/rdp", label: "RDP 远程桌面", hint: "通过 Guacamole 渲染", icon: Monitor, protocol: "rdp" })
    // Plan 17 — surface the new worker-based stack. M2 + Plan 18 ship the
    // real freerdp worker; the dummy-test-pattern note is obsolete.
    out.push({
      href: "/rdp-next",
      label: "RDP (Beta · 新栈)",
      hint: "DesktopWorker 子进程 + 浏览器自研 viewer",
      icon: Monitor,
      protocol: "rdp_next",
    })
  } else if (protocol === "vnc") {
    out.push({ href: "/vnc", label: "VNC 远程桌面", hint: "通过 Guacamole 渲染", icon: Monitor, protocol: "vnc" })
  } else if (["mysql", "postgres", "redis", "mongo"].includes(protocol)) {
    if (protocol === "mysql" || protocol === "postgres") {
      out.push({
        href: "/db",
        label: "数据库浏览",
        hint: "可视化 schema / 表浏览 / SQL 编辑器",
        icon: TableIcon,
        protocol: "db_studio",
      })
    }
    out.push({ href: "/dbcli", label: "数据库 CLI", hint: "一次性容器，会话结束自动销毁", icon: TerminalIcon, protocol: "dbcli" })
  }
  if (protocol === "tcp") {
    out.push({ href: "/sftp", label: "SFTP 文件管理", hint: "（如果目标支持）", icon: FolderOpen, protocol: "sftp" })
  }
  out.push({ href: "/port-forwards", label: "端口转发", hint: "管理网关本地 TCP 转发端口", icon: Share2, external: true })
  const seen = new Set<string>()
  return out.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true)))
}

// ActionCard renders one protocol entry. When the action maps to a
// workspace Protocol, clicking the card opens a workspace tab (the
// preferred flow); otherwise it navigates to the standalone page. The
// standalone page is always linked as a small secondary link below.
function ActionCard({
  action,
  node,
  nodeId,
}: {
  action: ActionItem
  node: { name: string; host: string; port: number }
  nodeId: number
}) {
  const router = useRouter()
  const open = useWorkspaceStore((s) => s.open)
  const standaloneHref = action.external
    ? (action.href as Parameters<typeof Link>[0]["href"])
    : ((`/nodes/${nodeId}${action.href}`) as Parameters<typeof Link>[0]["href"])

  if (!action.protocol) {
    // No workspace mapping (e.g. port-forwards) — keep classic Link card.
    return (
      <Link
        href={standaloneHref}
        className="rounded-lg border p-4 hover:bg-accent hover:border-primary/40 transition-all group"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium">
            <action.icon className="w-4 h-4" />
            {action.label}
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{action.hint}</div>
      </Link>
    )
  }

  const openInWorkspace = () => {
    open({
      nodeId,
      protocol: action.protocol!,
      title: node.name,
      host: node.host,
      port: node.port,
    })
    router.push("/workspace" as Parameters<typeof router.push>[0])
  }

  return (
    <div className="rounded-lg border p-4 hover:border-primary/40 transition-all">
      <button
        type="button"
        className="w-full text-left group"
        onClick={openInWorkspace}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-medium">
            <action.icon className="w-4 h-4" />
            {action.label}
          </div>
          <span className="inline-flex items-center gap-1 text-xs text-primary group-hover:underline">
            <LayoutGrid className="w-3 h-3" /> 在工作台打开
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{action.hint}</div>
      </button>
      <Link
        href={standaloneHref}
        className="mt-2 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
      >
        或单独页面打开 <ArrowRight className="w-3 h-3" />
      </Link>
    </div>
  )
}
