"use client"

import * as React from "react"
import { use } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ArrowRight, FolderOpen, Server, Share2, Terminal as TerminalIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { nodeService } from "@/lib/api/services"

export default function NodeDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const node = useQuery({ queryKey: ["node", nodeId], queryFn: () => nodeService.get(nodeId) })

  if (node.isLoading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>
  if (!node.data) return <div className="p-6 text-sm text-muted-foreground">节点不存在</div>
  const n = node.data
  const actions = actionList(n.protocol)

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="w-5 h-5" /> {n.name}
          </CardTitle>
          <CardDescription>
            <Badge variant="secondary" className="mr-2">{n.protocol.toUpperCase()}</Badge>
            <span className="text-xs text-muted-foreground">{n.host}:{n.port}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-6 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <Field label="用户名" value={n.username || "—"} />
          <Field label="代理链" value={n.proxy_chain || "直连"} />
          <Field label="区域" value={n.region || "—"} />
          <Field label="标签" value={n.tags || "—"} />
          {n.description && <div className="md:col-span-2"><Field label="描述" value={n.description} /></div>}
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={`/nodes/${nodeId}${a.href}` as Parameters<typeof Link>[0]["href"]}
            className="rounded-lg border p-4 hover:bg-accent transition-colors"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium">
                <a.icon className="w-4 h-4" />
                {a.label}
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{a.hint}</div>
          </Link>
        ))}
      </div>
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

function actionList(protocol: string) {
  const base: { href: string; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = []
  if (protocol === "ssh") {
    base.push({ href: "/ssh", label: "SSH 终端", hint: "在浏览器里打开 SSH", icon: TerminalIcon })
    base.push({ href: "/sftp", label: "SFTP 文件管理", hint: "上传 / 下载 / 编辑", icon: FolderOpen })
  } else if (protocol === "telnet") {
    base.push({ href: "/telnet", label: "Telnet 终端", hint: "适合网络设备", icon: TerminalIcon })
  } else if (protocol === "rdp") {
    base.push({ href: "/rdp", label: "RDP 远程桌面", hint: "通过 Guacamole 渲染", icon: TerminalIcon })
  } else if (protocol === "vnc") {
    base.push({ href: "/vnc", label: "VNC 远程桌面", hint: "通过 Guacamole 渲染", icon: TerminalIcon })
  } else if (["mysql", "postgres", "redis", "mongo"].includes(protocol)) {
    base.push({ href: "/dbcli", label: "数据库 CLI", hint: "一次性容器，会自动销毁", icon: TerminalIcon })
  }
  base.push({ href: "/sftp", label: "SFTP 文件管理", hint: "上传 / 下载 / 编辑", icon: FolderOpen })
  base.push({ href: "/portforward", label: "申请端口转发", hint: "网关本地监听 → 节点", icon: Share2 })
  // dedupe
  const seen = new Set<string>()
  return base.filter((b) => (seen.has(b.href) ? false : (seen.add(b.href), true)))
}

// Unused but exposed so other files importing Button/Card from this module don't tree-shake oddly.
export { Button }
