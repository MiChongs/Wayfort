"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, Bot, KeyRound, Loader2, Power, ShieldX, Trash2, Wifi, WifiOff } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CopyButton } from "@/components/common/copy-button"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { agentService } from "@/lib/api/services"
import type { AgentGatewayInfo, AgentStatus, Domain, GatewayAgent } from "@/lib/api/types"
import { relTime } from "@/lib/format"

const STATUS_META: Record<AgentStatus, { label: string; className: string }> = {
  pending: { label: "待激活", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  online: { label: "在线", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  offline: { label: "离线", className: "bg-muted text-muted-foreground" },
  revoked: { label: "已吊销", className: "bg-destructive/15 text-destructive" },
}

// installCommand composes the copy-paste line. Prefer the server-authoritative
// install script (it downloads the right binary and bakes in the wss server URL);
// fall back to a bare enroll when the download endpoint isn't configured. An
// optional name keeps multi-agent fleets — several agents per domain = HA —
// distinguishable.
function installCommand(info: AgentGatewayInfo | undefined, token: string, name: string): string {
  const safeName = name.trim().replace(/[^\w.-]/g, "")
  const nameArg = safeName ? ` --name ${safeName}` : ""
  if (info?.script_path && typeof window !== "undefined") {
    const url = `${window.location.origin}${info.script_path}`
    return `curl -fsSL ${url} | sh -s -- --token ${token}${nameArg}`
  }
  const server =
    info?.server ??
    (typeof window !== "undefined" ? `wss://${window.location.hostname}:8443` : "wss://your-bastion:8443")
  return `gateway-agent enroll --server ${server} --token ${token}${nameArg}`
}

interface AgentManagerSheetProps {
  domain: Domain
  trigger: React.ReactNode
}

export function AgentManagerSheet({ domain, trigger }: AgentManagerSheetProps) {
  const qc = useQueryClient()
  const [open, setOpen] = React.useState(false)
  const KEY = ["admin", "domains", domain.id, "agents"] as const

  const q = useQuery({
    queryKey: KEY,
    queryFn: () => agentService.list(domain.id),
    enabled: open,
    refetchInterval: open ? 8000 : false, // live-ish status while the sheet is open
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY })

  // Agent面 status — to compose the install command and warn when the listener
  // is off (a freshly enrolled agent would otherwise just never connect).
  const infoQ = useQuery({
    queryKey: ["admin", "agent-gateway", "info"],
    queryFn: () => agentService.info(),
    enabled: open,
  })
  const info = infoQ.data

  // The freshly minted token is held in component state — shown once, never refetched.
  const [token, setToken] = React.useState<string | null>(null)
  // Optional display name so a multi-agent fleet stays distinguishable.
  const [agentName, setAgentName] = React.useState("")

  const genToken = useMutation({
    mutationFn: () => agentService.generateToken(domain.id),
    onSuccess: (res) => {
      setToken(res.token)
      toast.success("注册令牌已生成", { description: "请立即复制——令牌只显示这一次" })
    },
    onError: (e: Error) => toast.error("生成失败", { description: e.message }),
  })

  const activate = useMutation({
    mutationFn: (id: number) => agentService.activate(id),
    onSuccess: () => { toast.success("Agent 已激活"); invalidate() },
    onError: (e: Error) => toast.error("激活失败", { description: e.message }),
  })

  async function onRevoke(a: GatewayAgent) {
    const ok = await confirmDialog({
      title: `吊销 Agent「${a.name}」？`,
      description: "将立即断开其隧道，且该 Agent 无法再连接。已在用的会话会中断。",
      confirmLabel: "吊销", destructive: true,
    })
    if (!ok) return
    try { await agentService.revoke(a.id); toast.success("已吊销"); invalidate() }
    catch (e) { toast.error("吊销失败", { description: (e as Error).message }) }
  }

  async function onDelete(a: GatewayAgent) {
    const ok = await confirmDialog({
      title: `删除 Agent「${a.name}」？`,
      description: "彻底移除该 Agent 记录并断开其隧道。",
      confirmLabel: "删除", destructive: true,
    })
    if (!ok) return
    try { await agentService.remove(a.id); toast.success("已删除"); invalidate() }
    catch (e) { toast.error("删除失败", { description: (e as Error).message }) }
  }

  const agents = q.data?.agents ?? []

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => { setOpen(v); if (!v) setToken(null) }}
    >
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-6 pb-4 pt-6">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-primary" />
            网关 Agent — {domain.name}
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          <div className="space-y-5">
            {/* Token generation */}
            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              {/* Why a freshly enrolled agent might never connect: listener off / no binary. */}
              {info && !info.enabled && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    Agent 监听器未启用。在网关配置 <code className="font-mono">agent.enabled=true</code> 并重启，否则 Agent 接入会被拒绝。
                  </span>
                </div>
              )}
              {info?.enabled && !info.binary_ready && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">
                    网关尚未放置 Agent 二进制。先执行 <code className="font-mono">scripts/build-agent.sh</code>，下方命令才能下载到二进制。
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">注册新 Agent</div>
                  <p className="text-xs text-muted-foreground">
                    一个 Agent 域可接入<strong>多个</strong> Agent —— 在每台内网主机执行安装命令即可，同域多 Agent 自动负载均衡 + 故障转移(HA)。
                  </p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => genToken.mutate()}
                  disabled={genToken.isPending}
                >
                  {genToken.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  生成注册令牌
                </Button>
              </div>

              {/* Optional name — distinguishes agents in a multi-agent domain. */}
              <Input
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="Agent 名称(可选，留空用主机名)"
                className="h-8 text-xs"
              />

              {token && (
                <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                    <KeyRound className="h-3.5 w-3.5 shrink-0" />
                    令牌只显示这一次，请立即复制安装命令
                  </div>
                  <div className="flex items-start gap-2">
                    <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1.5 font-mono text-xs">
                      {installCommand(info, token, agentName)}
                    </code>
                    <CopyButton value={installCommand(info, token, agentName)} size="sm" variant="outline" />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    在内网主机执行。接入后处于「待激活」，需在下方手动激活后才承载会话。多接几台就再生成令牌、换台机器重复执行。
                  </p>
                </div>
              )}
            </div>

            {/* Agent list */}
            {agents.length === 0 && !q.isLoading ? (
              <EmptyState
                icon={Bot}
                title="还没有接入任何 Agent"
                description="生成注册令牌并在内网主机运行安装命令，Agent 会出现在这里等待激活。"
              />
            ) : (
              <div className="space-y-2">
                {agents.map((a) => {
                  const meta = STATUS_META[a.status]
                  return (
                    <div key={a.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{a.name}</span>
                          <Badge variant="secondary" className={`font-normal ${meta.className}`}>
                            {meta.label}
                          </Badge>
                          {a.connected ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                              <Wifi className="h-3 w-3" /> 已连接
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <WifiOff className="h-3 w-3" /> 未连接
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {a.version ? `v${a.version} · ` : ""}
                          {a.last_seen_at ? `最近活跃 ${relTime(a.last_seen_at)}` : "从未连接"}
                          {a.cert_expires_at ? ` · 证书 ${relTime(a.cert_expires_at)}到期` : ""}
                        </div>
                        {a.status === "pending" && (a.fingerprint || a.enroll_ip) && (
                          <div className="mt-1 rounded bg-amber-500/5 px-2 py-1 text-[11px] text-muted-foreground">
                            <span className="font-medium text-amber-700 dark:text-amber-400">激活前核对</span>
                            {a.fingerprint && <span className="ml-1 break-all font-mono">指纹 {a.fingerprint.slice(0, 16)}…</span>}
                            {a.enroll_ip && <span className="ml-1">· 来源 {a.enroll_ip}</span>}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {a.status === "pending" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => activate.mutate(a.id)}
                            disabled={activate.isPending}
                          >
                            <Power className="h-3.5 w-3.5" /> 激活
                          </Button>
                        )}
                        {a.status !== "revoked" && (
                          <Button size="icon-sm" variant="ghost" onClick={() => onRevoke(a)} aria-label="吊销">
                            <ShieldX className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                        <Button size="icon-sm" variant="ghost" onClick={() => onDelete(a)} aria-label="删除">
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
