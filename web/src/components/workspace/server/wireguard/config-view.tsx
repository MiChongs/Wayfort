"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { useQuery } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import { Download, Loader2, RefreshCw, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CopyButton } from "@/components/common/copy-button"
import { wireguardService, type WGIface } from "@/lib/api/services"
import { wireguardApplyStreamURL } from "../_live"
import { RunInTerminalButton } from "../_shared"
import { StreamConsole } from "./stream-console"
import { downloadText, SectionHeader, WgEmpty } from "./shared"

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="inline-flex items-center gap-2 p-4 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" /> 加载查看器…
    </div>
  ),
})

// ConfigView is read-only on purpose: the conf is shown with secrets masked, so
// editing here can't clobber the private key. Structured edits go through the
// interface/peer dialogs (which preserve secrets server-side). From here you can
// copy/download the conf and apply the on-disk config to the running interface.
export function ConfigView({
  nodeId,
  tabId,
  ifaces,
  active,
}: {
  nodeId: number
  tabId: string
  ifaces: WGIface[]
  active: boolean
}) {
  const { theme } = useTheme()
  const [sel, setSel] = React.useState(ifaces[0]?.name ?? "")
  const [apply, setApply] = React.useState<null | "sync" | "reload">(null)

  React.useEffect(() => {
    if (!ifaces.find((i) => i.name === sel) && ifaces[0]) setSel(ifaces[0].name)
  }, [ifaces, sel])

  const conf = useQuery({
    queryKey: ["wg", nodeId, "conf", sel],
    queryFn: () => wireguardService.readConf(nodeId, sel),
    enabled: active && !!sel,
  })

  if (!active) return null
  if (ifaces.length === 0) return <WgEmpty title="暂无接口" sub="先在「接口」页创建一个 WireGuard 接口。" />

  const content = conf.data?.content ?? ""

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader title="配置文件">
        <Select value={sel} onValueChange={setSel}>
          <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ifaces.map((i) => (
              <SelectItem key={i.name} value={i.name} className="font-mono text-xs">{i.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="刷新" onClick={() => conf.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <CopyButton value={content} className="h-7 w-7" />
        <Button variant="ghost" size="icon" className="h-7 w-7" title="下载 .conf" onClick={() => downloadText(`${sel}.conf`, content)}>
          <Download className="h-3.5 w-3.5" />
        </Button>
      </SectionHeader>

      <div className="min-h-0 flex-1">
        {conf.isLoading ? (
          <div className="inline-flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 读取配置…</div>
        ) : conf.data && !conf.data.exists ? (
          <WgEmpty title="无配置文件" sub={`${sel} 没有 /etc/wireguard/${sel}.conf`} />
        ) : (
          <MonacoEditor
            height="100%"
            language="ini"
            theme={theme === "dark" ? "vs-dark" : "light"}
            value={content}
            options={{
              readOnly: true,
              fontSize: 12,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              lineNumbers: "on",
            }}
          />
        )}
      </div>

      <div className="flex items-center gap-2 border-t bg-card px-3 py-1.5">
        <span className="text-[10px] text-muted-foreground">私钥已脱敏 · 编辑请用接口/对端面板</span>
        <div className="ml-auto flex items-center gap-1.5">
          <RunInTerminalButton tabId={tabId} command={`wg-quick strip ${sel}`} run={false} label="strip" size="sm" />
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => setApply("sync")}>
            <RotateCw className="h-3.5 w-3.5" /> 热同步
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setApply("reload")}>
            重载
          </Button>
        </div>
      </div>

      <StreamConsole
        open={apply !== null}
        title={`应用配置 · ${sel} (${apply === "reload" ? "重载" : "热同步"})`}
        description={apply === "reload" ? "wg-quick down && up，会短暂断流。" : "wg syncconf，不断开隧道。"}
        url={apply ? wireguardApplyStreamURL(nodeId, sel, apply) : ""}
        onClose={() => setApply(null)}
      />
    </div>
  )
}
