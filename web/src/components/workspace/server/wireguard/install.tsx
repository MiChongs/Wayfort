"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, Loader2, PackageOpen, ShieldQuestion } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { wireguardService } from "@/lib/api/services"
import { RunInTerminalButton } from "../_shared"
import { wireguardInstallStreamURL } from "../_live"
import { StreamConsole } from "./stream-console"
import { WgEmpty } from "./shared"

/**
 * InstallPanel is the not-installed state: it probes the host, shows what a
 * one-click install would run, and streams the install live. On success the
 * parent's SSE status flips to available automatically.
 */
export function InstallPanel({
  nodeId,
  tabId,
  active,
  reason,
}: {
  nodeId: number
  tabId: string
  active: boolean
  reason?: string
}) {
  const [installing, setInstalling] = React.useState(false)
  const probe = useQuery({
    queryKey: ["wg", nodeId, "probe"],
    queryFn: () => wireguardService.probe(nodeId),
    enabled: active,
  })

  const pm = probe.data?.pkg_manager
  const preview = probe.data?.cmd_preview

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WgEmpty
        title="WireGuard 未安装"
        sub={reason ?? "目标主机未找到 wg 命令。可一键安装 wireguard-tools，过程实时回显。"}
        action={
          <div className="flex flex-col items-center gap-2">
            {probe.isLoading ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> 探测发行版…
              </span>
            ) : pm ? (
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <PackageOpen className="h-3.5 w-3.5" /> 包管理器
                  <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{pm}</Badge>
                  {probe.data && !probe.data.can_sudo && (
                    <Badge className="h-4 border-warning/40 bg-warning/[0.08] px-1.5 text-[10px] text-warning">
                      无 sudo NOPASSWD
                    </Badge>
                  )}
                </div>
                {preview && (
                  <code className="max-w-xs truncate rounded bg-muted/60 px-2 py-1 font-mono text-[10px] text-muted-foreground" title={preview}>
                    {preview}
                  </code>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setInstalling(true)}>
                    <Download className="h-3.5 w-3.5" /> 一键安装
                  </Button>
                  {preview && <RunInTerminalButton tabId={tabId} command={preview} run={false} label="改到终端" size="sm" />}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldQuestion className="h-3.5 w-3.5" /> 未检出受支持的包管理器
                </span>
                <RunInTerminalButton tabId={tabId} command="apt-get install -y wireguard wireguard-tools" run={false} label="改到终端手动安装" size="sm" />
              </div>
            )}
          </div>
        }
      />
      <StreamConsole
        open={installing}
        title="安装 WireGuard"
        description="正在通过包管理器安装 wireguard-tools，请稍候…"
        url={wireguardInstallStreamURL(nodeId)}
        onClose={() => setInstalling(false)}
        onComplete={() => void probe.refetch()}
      />
    </div>
  )
}
