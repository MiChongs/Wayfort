"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Box,
  Container as ContainerIcon,
  Download,
  Loader2,
  MoreHorizontal,
  Network as NetworkIcon,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
  TerminalSquare,
  Zap,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfirm } from "@/components/admin/use-confirm"
import { usagePctTone } from "@/components/insights/format"
import { VirtualTable } from "@/components/common/virtual-table"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { dockerStatsStreamURL } from "./_live"
import { dockerService } from "@/lib/api/services"
import type { DockerContainer, DockerImage, DockerStats } from "@/lib/api/types"
import { cn } from "@/lib/utils"
import { RunInTerminalButton, useSendToTerminal, codeOf, type ApiError } from "./_shared"

type Props = { nodeId: number; tabId: string; active: boolean }
type CVerb = "start" | "stop" | "restart" | "pause" | "unpause" | "kill" | "remove"

export function DockerTab({ nodeId, tabId, active }: Props) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [detailCid, setDetailCid] = React.useState<string | null>(null)
  const [pruneOut, setPruneOut] = React.useState<{ title: string; output: string } | null>(null)

  const status = useQuery({
    queryKey: ["docker", nodeId, "status"],
    queryFn: () => dockerService.status(nodeId),
    enabled: active,
    refetchInterval: 30_000,
  })
  const containers = useQuery({
    queryKey: ["docker", nodeId, "containers"],
    queryFn: () => dockerService.listContainers(nodeId),
    enabled: active && !!status.data?.available,
    refetchInterval: 15_000,
  })
  // Live per-container CPU/mem over SSE — pushed every few seconds without a
  // per-tick request, so the container table's stats columns tick on their own.
  const statsUrl = React.useMemo(() => dockerStatsStreamURL(nodeId), [nodeId])
  const statsStream = useSseSnapshot<{ stats: DockerStats[] }>(statsUrl, {
    enabled: active && !!status.data?.available,
  })

  const invalidate = React.useCallback(() => void qc.invalidateQueries({ queryKey: ["docker", nodeId] }), [nodeId, qc])

  const action = useMutation({
    mutationFn: ({ verb, cid }: { verb: CVerb; cid: string }) => {
      switch (verb) {
        case "start": return dockerService.start(nodeId, cid)
        case "stop": return dockerService.stop(nodeId, cid)
        case "restart": return dockerService.restart(nodeId, cid)
        case "pause": return dockerService.pause(nodeId, cid)
        case "unpause": return dockerService.unpause(nodeId, cid)
        case "kill": return dockerService.kill(nodeId, cid)
        case "remove": return dockerService.remove(nodeId, cid, true)
      }
    },
    onSuccess: (_d, v) => { toast.success(`已${verbLabel(v.verb)}`); invalidate() },
    onError: (e: ApiError, v) => toast.error(`${verbLabel(v.verb)}失败`, { description: e?.message }),
  })

  const prune = useMutation({
    mutationFn: (what: string) => dockerService.prune(nodeId, what),
    onSuccess: (r, what) => { setPruneOut({ title: `prune ${what}`, output: r.output }); invalidate() },
    onError: (e: ApiError) => toast.error("清理失败", { description: e?.message }),
  })

  const statByShort = React.useMemo(() => {
    const m = new Map<string, DockerStats>()
    for (const s of statsStream.data?.stats ?? []) m.set(s.id, s)
    return m
  }, [statsStream.data])

  if (!active) return null

  if (status.isLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> 探测 Docker 守护进程…</div>
  }
  if (!status.data?.available) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Box className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">Docker 不可用</div>
        <div className="text-xs">{status.data?.reason || "节点上未找到 docker 命令"}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => status.refetch()}><RefreshCw className="w-3 h-3" /> 重试</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {dialog}
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Box className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium">Docker {status.data.version}</span>
          <span className="text-[10px] text-muted-foreground truncate">{status.data.containers} 容器 · {status.data.images} 镜像</span>
        </div>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" title="清理 (prune)"><Zap className="w-3.5 h-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onClick={async () => { if (await confirm({ title: "system prune？", description: "删除所有停止的容器、悬空镜像、未用网络与构建缓存。", confirmLabel: "清理" })) prune.mutate("system") }}>清理全部 (system)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => prune.mutate("image")}>未用镜像</DropdownMenuItem>
              <DropdownMenuItem onClick={() => prune.mutate("container")}>停止的容器</DropdownMenuItem>
              <DropdownMenuItem onClick={() => prune.mutate("volume")}>未用卷</DropdownMenuItem>
              <DropdownMenuItem onClick={() => prune.mutate("network")}>未用网络</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => invalidate()} title="刷新"><RefreshCw className={cn("w-3 h-3", (status.isFetching || containers.isFetching) && "animate-spin")} /></Button>
        </div>
      </header>

      <Tabs defaultValue="containers" className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-2 mt-2 h-8 bg-transparent border-b rounded-none p-0 self-start">
          <TabsTrigger value="containers" className="text-xs">容器</TabsTrigger>
          <TabsTrigger value="images" className="text-xs">镜像</TabsTrigger>
          <TabsTrigger value="networks" className="text-xs">网络</TabsTrigger>
          <TabsTrigger value="volumes" className="text-xs">卷</TabsTrigger>
        </TabsList>

        <TabsContent value="containers" className="mt-0 flex min-h-0 flex-1 flex-col">
          <VirtualTable
            rows={containers.data?.containers ?? []}
            empty="没有容器"
            header={
              <>
                <th className="px-2 py-1.5 text-left">名称</th>
                <th className="px-2 py-1.5 text-left">状态</th>
                <th className="w-12 px-2 py-1.5 text-right">CPU</th>
                <th className="w-12 px-2 py-1.5 text-right">内存</th>
                <th className="w-16 px-2 py-1.5 text-right"></th>
              </>
            }
            renderRow={(c) => (
              <ContainerRow
                c={c}
                tabId={tabId}
                stat={statByShort.get(c.id.slice(0, 12))}
                busy={action.isPending}
                onAction={async (verb) => {
                  if (verb === "remove" || verb === "kill") {
                    if (!(await confirm({ title: `${verbLabel(verb)} ${c.names || c.id.slice(0, 12)}？`, description: verb === "remove" ? "强制删除容器（持久卷不受影响）。" : "立即 SIGKILL 容器进程。", confirmLabel: verbLabel(verb) }))) return
                  }
                  action.mutate({ verb, cid: c.id })
                }}
                onDetail={() => setDetailCid(c.id)}
                onRename={async (name) => { try { await dockerService.rename(nodeId, c.id, name); toast.success("已重命名"); invalidate() } catch (e) { toast.error("重命名失败", { description: (e as ApiError)?.message }) } }}
              />
            )}
          />
        </TabsContent>

        <TabsContent value="images" className="flex-1 min-h-0 mt-0 flex flex-col">
          <ImagesPanel nodeId={nodeId} onMutated={invalidate} confirm={confirm} setPruneOut={setPruneOut} />
        </TabsContent>

        <TabsContent value="networks" className="flex-1 min-h-0 mt-0 overflow-auto">
          <NetworksPanel nodeId={nodeId} active={active} />
        </TabsContent>
        <TabsContent value="volumes" className="flex-1 min-h-0 mt-0 overflow-auto">
          <VolumesPanel nodeId={nodeId} active={active} />
        </TabsContent>
      </Tabs>

      <DetailSheet nodeId={nodeId} tabId={tabId} cid={detailCid} onClose={() => setDetailCid(null)} />

      <Sheet open={!!pruneOut} onOpenChange={(v) => !v && setPruneOut(null)}>
        <SheetContent side="right" className="w-[min(560px,calc(100vw-2rem))] sm:max-w-none flex flex-col gap-3">
          <SheetHeader><SheetTitle className="font-mono">{pruneOut?.title}</SheetTitle></SheetHeader>
          <pre className="flex-1 overflow-auto bg-muted/60 rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words">{pruneOut?.output || "（无输出）"}</pre>
        </SheetContent>
      </Sheet>
    </div>
  )
}

function ContainerRow({ c, tabId, stat, busy, onAction, onDetail, onRename }: {
  c: DockerContainer; tabId: string; stat?: DockerStats; busy: boolean
  onAction: (verb: CVerb) => void; onDetail: () => void; onRename: (name: string) => void
}) {
  const running = c.state === "running"
  const paused = c.state === "paused"
  return (
    <>
      <td className="px-2 py-1.5 min-w-0 align-top">
        <button type="button" onClick={onDetail} className="font-medium truncate max-w-[10rem] hover:text-primary text-left block" title={c.command}>{c.names || c.id.slice(0, 12)}</button>
        <div className="text-[10px] text-muted-foreground font-mono truncate max-w-[10rem]">{c.image}</div>
      </td>
      <td className="px-2 py-1.5">
        <Badge variant={running ? "success" : paused ? "warning" : "secondary"} className="text-[10px]">{c.state}</Badge>
      </td>
      <td className={cn("px-2 py-1.5 text-right tabular-nums", stat && usagePctTone(stat.cpu_pct))}>{stat ? `${stat.cpu_pct.toFixed(0)}%` : "—"}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{stat ? `${stat.mem_pct.toFixed(0)}%` : "—"}</td>
      <td className="px-2 py-1.5 text-right">
        <div className="inline-flex gap-0.5">
          {running || paused ? (
            <Button variant="ghost" size="icon" className="h-6 w-6" title="停止" disabled={busy} onClick={() => onAction("stop")}><Square className="w-3 h-3" /></Button>
          ) : (
            <Button variant="ghost" size="icon" className="h-6 w-6" title="启动" disabled={busy} onClick={() => onAction("start")}><Play className="w-3 h-3" /></Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" title="更多" disabled={busy}><MoreHorizontal className="w-3 h-3" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onClick={() => onAction("restart")}><RotateCw className="w-3.5 h-3.5" /> 重启</DropdownMenuItem>
              {paused ? (
                <DropdownMenuItem onClick={() => onAction("unpause")}><Play className="w-3.5 h-3.5" /> 恢复</DropdownMenuItem>
              ) : running ? (
                <DropdownMenuItem onClick={() => onAction("pause")}><Pause className="w-3.5 h-3.5" /> 暂停</DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={onDetail}><ContainerIcon className="w-3.5 h-3.5" /> 详情 / 日志</DropdownMenuItem>
              <RenameItem current={c.names} onRename={onRename} />
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onAction("kill")}>SIGKILL</DropdownMenuItem>
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onAction("remove")}><Trash2 className="w-3.5 h-3.5" /> 删除</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </>
  )
}

function RenameItem({ current, onRename }: { current: string; onRename: (name: string) => void }) {
  return (
    <DropdownMenuItem onSelect={(e) => {
      e.preventDefault()
      const name = window.prompt("新容器名", current)
      if (name && name.trim()) onRename(name.trim())
    }}>重命名</DropdownMenuItem>
  )
}

function ImagesPanel({ nodeId, onMutated, confirm, setPruneOut }: {
  nodeId: number; onMutated: () => void
  confirm: (o: { title: string; description?: string; confirmLabel?: string }) => Promise<boolean>
  setPruneOut: (v: { title: string; output: string } | null) => void
}) {
  const [pullRef, setPullRef] = React.useState("")
  const images = useQuery({ queryKey: ["docker", nodeId, "images"], queryFn: () => dockerService.listImages(nodeId), refetchInterval: 60_000 })
  const pull = useMutation({
    mutationFn: () => dockerService.pullImage(nodeId, pullRef.trim()),
    onSuccess: (r) => { setPruneOut({ title: `pull ${pullRef}`, output: r.output }); setPullRef(""); onMutated() },
    onError: (e: ApiError) => toast.error("拉取失败", { description: e?.message }),
  })
  const rmi = useMutation({
    mutationFn: (ref: string) => dockerService.removeImage(nodeId, ref, false),
    onSuccess: () => { toast.success("已删除镜像"); onMutated() },
    onError: (e: ApiError) => toast.error("删除失败", { description: e?.message }),
  })
  return (
    <>
      <div className="p-2 border-b flex items-center gap-1.5">
        <Input value={pullRef} onChange={(e) => setPullRef(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && pullRef.trim()) pull.mutate() }} placeholder="拉取镜像，如 nginx:latest" className="h-7 text-xs font-mono flex-1" />
        <Button size="sm" className="h-7 text-xs" disabled={!pullRef.trim() || pull.isPending} onClick={() => pull.mutate()}>{pull.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} 拉取</Button>
      </div>
      <div className="min-h-0 flex-1">
        {images.isLoading ? (
          <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 加载镜像…</div>
        ) : (
          <VirtualTable
            rows={images.data?.images ?? []}
            empty="没有镜像"
            header={
              <>
                <th className="px-2 py-1.5 text-left">仓库:标签</th>
                <th className="px-2 py-1.5 text-left">大小</th>
                <th className="w-8 px-2 py-1.5 text-right"></th>
              </>
            }
            renderRow={(i: DockerImage) => {
              const ref = i.repository && i.repository !== "<none>" ? `${i.repository}:${i.tag}` : i.id
              return (
                <>
                  <td className="max-w-[14rem] truncate px-2 py-1.5 font-mono" title={ref}>{i.repository}:{i.tag}</td>
                  <td className="px-2 py-1.5 font-mono text-muted-foreground">{i.size}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" title="删除镜像" disabled={rmi.isPending}
                      onClick={async () => { if (await confirm({ title: `删除镜像 ${ref}？`, confirmLabel: "删除" })) rmi.mutate(ref) }}><Trash2 className="h-3 w-3" /></Button>
                  </td>
                </>
              )
            }}
          />
        )}
      </div>
    </>
  )
}

function NetworksPanel({ nodeId, active }: { nodeId: number; active: boolean }) {
  const q = useQuery({ queryKey: ["docker", nodeId, "networks"], queryFn: () => dockerService.networks(nodeId), enabled: active })
  return (
    <table className="w-full text-[11px]">
      <thead className="bg-muted/40 sticky top-0 text-[10px] uppercase text-muted-foreground"><tr><th className="text-left px-3 py-1.5">名称</th><th className="text-left px-2 py-1.5">驱动</th><th className="text-left px-3 py-1.5">范围</th></tr></thead>
      <tbody className="divide-y divide-border/40">
        {(q.data?.networks ?? []).map((n) => (
          <tr key={n.id} className="hover:bg-muted/50"><td className="px-3 py-1 font-mono inline-flex items-center gap-1.5"><NetworkIcon className="w-3 h-3 text-muted-foreground" />{n.name}</td><td className="px-2 py-1 text-muted-foreground">{n.driver}</td><td className="px-3 py-1 text-muted-foreground">{n.scope}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

function VolumesPanel({ nodeId, active }: { nodeId: number; active: boolean }) {
  const q = useQuery({ queryKey: ["docker", nodeId, "volumes"], queryFn: () => dockerService.volumes(nodeId), enabled: active })
  return (
    <table className="w-full text-[11px]">
      <thead className="bg-muted/40 sticky top-0 text-[10px] uppercase text-muted-foreground"><tr><th className="text-left px-3 py-1.5">卷名</th><th className="text-left px-2 py-1.5">驱动</th></tr></thead>
      <tbody className="divide-y divide-border/40">
        {(q.data?.volumes ?? []).map((v) => (
          <tr key={v.name} className="hover:bg-muted/50"><td className="px-3 py-1 font-mono truncate max-w-[16rem]" title={v.mountpoint}>{v.name}</td><td className="px-2 py-1 text-muted-foreground">{v.driver}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

function DetailSheet({ nodeId, tabId, cid, onClose }: { nodeId: number; tabId: string; cid: string | null; onClose: () => void }) {
  const send = useSendToTerminal(tabId)
  const detail = useQuery({ queryKey: ["docker", nodeId, "inspect", cid], queryFn: () => dockerService.inspect(nodeId, cid as string), enabled: !!cid, retry: false })
  const d = detail.data
  return (
    <Sheet open={!!cid} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[min(640px,calc(100vw-2rem))] sm:max-w-none flex flex-col gap-3">
        <SheetHeader>
          <SheetTitle className="truncate">{d?.name || cid?.slice(0, 12)}</SheetTitle>
          <SheetDescription className="font-mono truncate">{d?.image}</SheetDescription>
        </SheetHeader>
        {cid && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => send(`docker exec -it ${cid} sh`, true)}><TerminalSquare className="w-3.5 h-3.5" /> exec 到终端</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => detail.refetch()}><RefreshCw className={cn("w-3.5 h-3.5", detail.isFetching && "animate-spin")} /></Button>
          </div>
        )}
        <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
          <TabsList className="h-8 self-start"><TabsTrigger value="overview" className="text-xs">概览</TabsTrigger><TabsTrigger value="top" className="text-xs">进程</TabsTrigger><TabsTrigger value="logs" className="text-xs">日志</TabsTrigger><TabsTrigger value="raw" className="text-xs">Raw</TabsTrigger></TabsList>
          <TabsContent value="overview" className="flex-1 min-h-0 mt-2 overflow-auto">
            {detail.isLoading ? <div className="text-xs text-muted-foreground inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</div> : d ? (
              <dl className="text-[11px] grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5">
                <KV k="状态" v={`${d.state}${d.restart_count ? ` · 重启 ${d.restart_count} 次` : ""}`} />
                <KV k="重启策略" v={d.restart_policy || "—"} />
                <KV k="IP" v={d.ip_address || "—"} mono />
                {d.cmd ? <KV k="命令" v={d.cmd} mono /> : null}
                {(d.ports?.length ?? 0) > 0 ? <KV k="端口" v={d.ports!.join("\n")} mono /> : null}
                {(d.networks?.length ?? 0) > 0 ? <KV k="网络" v={d.networks!.join(", ")} /> : null}
                {(d.mounts?.length ?? 0) > 0 ? <KV k="挂载" v={d.mounts!.join("\n")} mono /> : null}
                {(d.env?.length ?? 0) > 0 ? <KV k="环境" v={d.env!.join("\n")} mono /> : null}
              </dl>
            ) : <div className="text-xs text-destructive">{(detail.error as ApiError)?.message || "加载失败"}</div>}
          </TabsContent>
          <TabsContent value="top" className="flex-1 min-h-0 mt-2 overflow-auto">
            {cid && <TopPanel nodeId={nodeId} cid={cid} />}
          </TabsContent>
          <TabsContent value="logs" className="flex-1 min-h-0 mt-2 overflow-auto">
            {cid && <LogsPanel nodeId={nodeId} cid={cid} />}
          </TabsContent>
          <TabsContent value="raw" className="flex-1 min-h-0 mt-2 overflow-auto">
            <pre className="bg-muted/60 rounded-md p-2 text-[10px] font-mono whitespace-pre overflow-auto">{d?.raw || ""}</pre>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function TopPanel({ nodeId, cid }: { nodeId: number; cid: string }) {
  const q = useQuery({ queryKey: ["docker", nodeId, "top", cid], queryFn: () => dockerService.top(nodeId, cid), refetchInterval: 5_000, retry: false })
  if (q.isLoading) return <div className="text-xs text-muted-foreground inline-flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> 加载…</div>
  if (!q.data || q.data.processes.length === 0) return <div className="text-xs text-muted-foreground">容器未运行或无进程</div>
  return (
    <table className="w-full text-[10px] font-mono">
      <thead className="text-[9px] uppercase text-muted-foreground"><tr>{q.data.titles.map((t) => <th key={t} className="text-left px-1.5 py-1">{t}</th>)}</tr></thead>
      <tbody className="divide-y divide-border/40">
        {q.data.processes.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="px-1.5 py-0.5 truncate max-w-[12rem]" title={cell}>{cell}</td>)}</tr>)}
      </tbody>
    </table>
  )
}

function LogsPanel({ nodeId, cid }: { nodeId: number; cid: string }) {
  const q = useQuery({ queryKey: ["docker", nodeId, "logs", cid], queryFn: () => dockerService.logs(nodeId, cid, 500), refetchInterval: 5_000, retry: false })
  return (
    <pre className="bg-muted/60 rounded-md p-2 text-[10px] font-mono whitespace-pre-wrap break-words leading-5">
      {q.isLoading ? "加载日志…" : q.data?.logs || "（空）"}
    </pre>
  )
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (<><dt className="text-muted-foreground">{k}</dt><dd className={cn("whitespace-pre-wrap break-words", mono && "font-mono")}>{v}</dd></>)
}

function verbLabel(v: CVerb): string {
  return { start: "启动", stop: "停止", restart: "重启", pause: "暂停", unpause: "恢复", kill: "强杀", remove: "删除" }[v] ?? v
}
