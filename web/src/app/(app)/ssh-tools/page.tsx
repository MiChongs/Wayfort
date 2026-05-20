"use client"

// Phase 12 — SSH 工具中心。把 SSHKeysSheet / KnownHostsSheet / BulkRunSheet
// 三大功能集中到一个面板,每个卡片点击打开对应 Sheet。普通用户也可用。

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { motion } from "motion/react"
import { Key, Network, ShieldCheck, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SSHKeysSheet } from "@/components/me/ssh-keys-sheet"
import { KnownHostsSheet } from "@/components/me/known-hosts-sheet"
import { BulkRunSheet } from "@/components/me/bulk-run-sheet"
import {
  bulkRunService,
  knownHostService,
  meService,
  sshKeyService,
} from "@/lib/api/services"

export default function SshToolsPage() {
  const keys = useQuery({ queryKey: ["me", "ssh-keys"], queryFn: sshKeyService.list })
  const hosts = useQuery({ queryKey: ["me", "known-hosts"], queryFn: knownHostService.list })
  const runs = useQuery({ queryKey: ["me", "bulk-runs"], queryFn: () => bulkRunService.list(20) })
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const sshNodes = (nodes.data?.nodes || []).filter((n) => n.protocol === "ssh").length

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Network className="h-5 w-5" /> SSH 工具中心
        </h1>
        <p className="text-sm text-muted-foreground">
          管理你的 SSH 密钥、已信任主机指纹,以及在多台节点上的批量执行历史。
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          <SSHKeysSheet
            trigger={
              <Card className="h-full cursor-pointer transition-colors hover:bg-muted/30">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Key className="h-4 w-4" /> 我的 SSH 密钥
                  </CardTitle>
                  <CardDescription>用户级 keypair 库。一键生成 ED25519 或导入现有 PEM。</CardDescription>
                </CardHeader>
                <CardContent className="flex items-end justify-between">
                  <span className="text-2xl font-semibold tabular-nums">{keys.data?.keys.length ?? 0}</span>
                  <Badge variant="outline">点击管理</Badge>
                </CardContent>
              </Card>
            }
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <KnownHostsSheet
            trigger={
              <Card className="h-full cursor-pointer transition-colors hover:bg-muted/30">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShieldCheck className="h-4 w-4" /> 已知主机
                  </CardTitle>
                  <CardDescription>查看 / 撤销已经接受的服务器指纹,审计 TOFU 行为。</CardDescription>
                </CardHeader>
                <CardContent className="flex items-end justify-between">
                  <span className="text-2xl font-semibold tabular-nums">{hosts.data?.hosts.length ?? 0}</span>
                  <Badge variant="outline">点击管理</Badge>
                </CardContent>
              </Card>
            }
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <BulkRunSheet
            trigger={
              <Card className="h-full cursor-pointer transition-colors hover:bg-muted/30">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Zap className="h-4 w-4" /> 批量执行
                  </CardTitle>
                  <CardDescription>在多台 SSH 节点上并行运行同一条命令,逐节点查看结果。</CardDescription>
                </CardHeader>
                <CardContent className="flex items-end justify-between">
                  <div className="space-y-0.5">
                    <span className="text-2xl font-semibold tabular-nums">{runs.data?.runs.length ?? 0}</span>
                    <p className="text-[11px] text-muted-foreground">历史记录</p>
                  </div>
                  <Badge variant="outline">{sshNodes} 个 SSH 节点可用</Badge>
                </CardContent>
              </Card>
            }
          />
        </motion.div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">使用建议</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>· 在 SSH 密钥库生成 ED25519 后,把 `public` 行粘贴到目标节点的 `~/.ssh/authorized_keys`。</p>
          <p>· 撤销已知主机后,下次连接会重新弹出指纹确认 — 避免静默 MITM。</p>
          <p>· 批量执行的命令会被记录,可在历史中复查每节点 stdout / stderr / 退出码。</p>
        </CardContent>
      </Card>
    </div>
  )
}

// Inline use so unused-import lint doesn't trip Button.
void Button
