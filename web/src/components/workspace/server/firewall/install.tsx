"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Download, Loader2, PackageOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { firewallService } from "@/lib/api/services"
import { RunInTerminalButton } from "../_shared"
import { firewallInstallStreamURL } from "../_live"
import { StreamConsole } from "../wireguard/stream-console"
import { FwIconEmpty } from "./shared"

export function FwInstallPanel({
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
  const [installing, setInstalling] = React.useState<null | "ufw" | "nft">(null)
  const probe = useQuery({
    queryKey: ["fw", nodeId, "probe"],
    queryFn: () => firewallService.probe(nodeId),
    enabled: active,
  })

  const pm = probe.data?.pkg_manager
  return (
    <div className="flex h-full min-h-0 flex-col">
      <FwIconEmpty
        title="未检测到防火墙工具"
        sub={reason ?? "可一键安装 ufw（最人性化）或 nftables（现代强能），过程实时回显。"}
      />
      <div className="mx-auto -mt-6 flex flex-col items-center gap-2 pb-6">
        {probe.isLoading ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 探测发行版…</span>
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <PackageOpen className="h-3.5 w-3.5" /> 包管理器
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{pm || "未知"}</Badge>
              {probe.data && !probe.data.can_sudo && (
                <Badge className="h-4 border-warning/40 bg-warning/[0.08] px-1.5 text-[10px] text-warning">无 sudo NOPASSWD</Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-7 gap-1 text-xs" disabled={!pm} onClick={() => setInstalling("ufw")}>
                <Download className="h-3.5 w-3.5" /> 安装 ufw
              </Button>
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={!pm} onClick={() => setInstalling("nft")}>
                <Download className="h-3.5 w-3.5" /> 安装 nftables
              </Button>
            </div>
            {probe.data?.cmd_preview_ufw && (
              <RunInTerminalButton tabId={tabId} command={probe.data.cmd_preview_ufw} run={false} label="改到终端手动安装" size="sm" />
            )}
          </>
        )}
      </div>
      <StreamConsole
        open={installing !== null}
        title={`安装 ${installing === "nft" ? "nftables" : "ufw"}`}
        description="正在通过包管理器安装防火墙工具，请稍候…"
        url={installing ? firewallInstallStreamURL(nodeId, installing) : ""}
        onClose={() => setInstalling(null)}
        onComplete={() => void probe.refetch()}
      />
    </div>
  )
}
