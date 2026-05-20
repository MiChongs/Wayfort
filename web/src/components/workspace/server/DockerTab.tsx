"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Box,
  Container as ContainerIcon,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useConfirm } from "@/components/admin/use-confirm"
import { dockerService } from "@/lib/api/services"
import type { DockerContainer } from "@/lib/api/types"

type Props = {
  nodeId: number
  active: boolean
}

// DockerTab — surfaces `docker ps -a` / `docker images` plus per-container
// actions (start/stop/restart/rm) and log preview. State changes invalidate
// the cache so the list reflects new container state within ~30s.
export function DockerTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
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
    refetchInterval: 30_000,
  })
  const images = useQuery({
    queryKey: ["docker", nodeId, "images"],
    queryFn: () => dockerService.listImages(nodeId),
    enabled: active && !!status.data?.available,
    refetchInterval: 60_000,
  })

  const [logCid, setLogCid] = React.useState<string | null>(null)

  const invalidate = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["docker", nodeId] })
  }, [nodeId, qc])

  if (!active) return null

  if (status.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="w-4 h-4 animate-spin" /> 探测 Docker 守护进程…
      </div>
    )
  }

  if (!status.data?.available) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Box className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">Docker 不可用</div>
        <div className="text-xs">
          {status.data?.reason || "节点上未找到 docker 命令"}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Box className="w-4 h-4 text-primary" />
          <span className="text-xs font-medium">Docker {status.data.version}</span>
          <span className="text-[10px] text-muted-foreground">
            {status.data.containers} 容器 · {status.data.images} 镜像
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => invalidate()}
          title="刷新"
        >
          <RefreshCw
            className={`w-3 h-3 ${
              status.isFetching || containers.isFetching || images.isFetching ? "animate-spin" : ""
            }`}
          />
        </Button>
      </header>

      <Tabs defaultValue="containers" className="flex-1 flex flex-col min-h-0">
        <TabsList className="h-8 mx-3 mt-2 self-start">
          <TabsTrigger value="containers" className="text-xs h-6">
            <ContainerIcon className="w-3 h-3" /> 容器
          </TabsTrigger>
          <TabsTrigger value="images" className="text-xs h-6">
            <Box className="w-3 h-3" /> 镜像
          </TabsTrigger>
        </TabsList>
        <TabsContent value="containers" className="flex-1 min-h-0 mt-0 overflow-auto">
          <ContainersTable
            list={containers.data?.containers ?? []}
            loading={containers.isLoading}
            nodeId={nodeId}
            onShowLogs={setLogCid}
            onMutated={invalidate}
          />
        </TabsContent>
        <TabsContent value="images" className="flex-1 min-h-0 mt-0 overflow-auto">
          <ImagesTable list={images.data?.images ?? []} loading={images.isLoading} />
        </TabsContent>
      </Tabs>

      <LogsDrawer nodeId={nodeId} containerId={logCid} onClose={() => setLogCid(null)} />
    </div>
  )
}

type ContainerVerb = "start" | "stop" | "restart" | "remove"
type ContainerActionPayload = { verb: ContainerVerb; cid: string; force?: boolean }

function ContainersTable({
  list,
  loading,
  nodeId,
  onShowLogs,
  onMutated,
}: {
  list: DockerContainer[]
  loading: boolean
  nodeId: number
  onShowLogs: (cid: string) => void
  onMutated: () => void
}) {
  // One mutation at the table level — rows dispatch by payload so we never
  // call useMutation per-row (would violate hooks rules with variable lists).
  const action = useMutation({
    mutationFn: ({ verb, cid, force }: ContainerActionPayload) => {
      switch (verb) {
        case "start":
          return dockerService.start(nodeId, cid)
        case "stop":
          return dockerService.stop(nodeId, cid)
        case "restart":
          return dockerService.restart(nodeId, cid)
        case "remove":
          return dockerService.remove(nodeId, cid, force ?? false)
      }
    },
    onSuccess: (_data, vars) => {
      toast.success(`已${labelOf(vars.verb)}`)
      onMutated()
    },
    onError: (e: { message?: string }, vars) =>
      toast.error(`${labelOf(vars.verb)}失败`, { description: e?.message }),
  })

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> 加载容器…
      </div>
    )
  }
  if (list.length === 0) {
    return <div className="text-xs text-muted-foreground p-6 text-center">没有容器</div>
  }
  return (
    <table className="w-full text-xs">
      <thead className="bg-muted/50 sticky top-0 text-[10px] uppercase text-muted-foreground">
        <tr>
          <th className="text-left px-2 py-1.5">名称</th>
          <th className="text-left px-2 py-1.5">镜像</th>
          <th className="text-left px-2 py-1.5">状态</th>
          <th className="text-left px-2 py-1.5">端口</th>
          <th className="text-right px-2 py-1.5">操作</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {list.map((c) => (
          <ContainerRow
            key={c.id}
            c={c}
            onLogs={() => onShowLogs(c.id)}
            onAction={(verb, force) => action.mutate({ verb, cid: c.id, force })}
            busy={action.isPending}
          />
        ))}
      </tbody>
    </table>
  )
}

function ContainerRow({
  c,
  onLogs,
  onAction,
  busy,
}: {
  c: DockerContainer
  onLogs: () => void
  onAction: (verb: ContainerVerb, force?: boolean) => void
  busy: boolean
}) {
  const running = c.state === "running"
  const { confirm: confirmDialog, dialog } = useConfirm()
  const onRemove = async () => {
    const ok = await confirmDialog({
      title: `删除容器 “${c.names || c.id.slice(0, 12)}”？`,
      description: "将以 force=true 立即终止并删除容器,持久卷不受影响。",
      confirmLabel: "删除",
    })
    if (ok) onAction("remove", true)
  }
  return (
    <>
      {dialog}
      <tr className="hover:bg-accent/40" title={c.command}>
      <td className="px-2 py-1.5">
        <div className="font-medium truncate max-w-[10rem]">{c.names || c.id.slice(0, 12)}</div>
        <div className="text-[10px] text-muted-foreground font-mono">{c.id.slice(0, 12)}</div>
      </td>
      <td className="px-2 py-1.5 truncate max-w-[12rem] font-mono">{c.image}</td>
      <td className="px-2 py-1.5">
        <Badge variant={running ? "success" : "secondary"} className="text-[10px]">
          {c.state}
        </Badge>
        <div className="text-[10px] text-muted-foreground mt-0.5 truncate max-w-[10rem]">
          {c.status}
        </div>
      </td>
      <td className="px-2 py-1.5 font-mono text-[10px] truncate max-w-[10rem]">{c.ports || "—"}</td>
      <td className="px-2 py-1.5 text-right">
        <div className="inline-flex gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="查看日志"
            onClick={onLogs}
          >
            <ContainerIcon className="w-3 h-3" />
          </Button>
          {running ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="停止"
              disabled={busy}
              onClick={() => onAction("stop")}
            >
              <Pause className="w-3 h-3" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="启动"
              disabled={busy}
              onClick={() => onAction("start")}
            >
              <Play className="w-3 h-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="重启"
            disabled={busy}
            onClick={() => onAction("restart")}
          >
            <RotateCw className="w-3 h-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive"
            title="删除（强制）"
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </td>
    </tr>
    </>
  )
}

function labelOf(verb: string): string {
  return { start: "启动", stop: "停止", restart: "重启", remove: "删除" }[verb] ?? verb
}

function ImagesTable({
  list,
  loading,
}: {
  list: { id: string; repository: string; tag: string; size: string; created_at: string }[]
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> 加载镜像…
      </div>
    )
  }
  if (list.length === 0) {
    return <div className="text-xs text-muted-foreground p-6 text-center">没有镜像</div>
  }
  return (
    <table className="w-full text-xs">
      <thead className="bg-muted/50 sticky top-0 text-[10px] uppercase text-muted-foreground">
        <tr>
          <th className="text-left px-2 py-1.5">仓库</th>
          <th className="text-left px-2 py-1.5">标签</th>
          <th className="text-left px-2 py-1.5">大小</th>
          <th className="text-left px-2 py-1.5">创建</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {list.map((i) => (
          <tr key={i.id} className="hover:bg-accent/40">
            <td className="px-2 py-1.5 font-mono truncate max-w-[12rem]">{i.repository}</td>
            <td className="px-2 py-1.5 font-mono">{i.tag}</td>
            <td className="px-2 py-1.5 font-mono">{i.size}</td>
            <td className="px-2 py-1.5 text-muted-foreground">{i.created_at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function LogsDrawer({
  nodeId,
  containerId,
  onClose,
}: {
  nodeId: number
  containerId: string | null
  onClose: () => void
}) {
  const logs = useQuery({
    queryKey: ["docker", nodeId, "logs", containerId],
    queryFn: () => dockerService.logs(nodeId, containerId as string, 500),
    enabled: !!containerId,
    refetchInterval: 5_000,
  })

  if (!containerId) return null

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[min(640px,90vw)] bg-card border-l shadow-xl flex flex-col">
      <header className="flex items-center justify-between gap-2 p-3 border-b">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">容器日志</div>
          <div className="text-[11px] text-muted-foreground font-mono truncate">
            {containerId.slice(0, 12)}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void logs.refetch()}
            title="立即刷新"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${logs.isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-auto bg-muted/40 p-3 font-mono text-[11px] whitespace-pre-wrap leading-5">
        {logs.isLoading ? (
          <div className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> 加载日志…
          </div>
        ) : logs.isError ? (
          <div className="text-destructive">
            {(logs.error as { message?: string })?.message || "加载失败"}
          </div>
        ) : logs.data?.logs ? (
          logs.data.logs
        ) : (
          <span className="text-muted-foreground">（空）</span>
        )}
      </div>
      <footer className="text-[10px] text-muted-foreground px-3 py-1.5 border-t">
        最近 {logs.data?.tail ?? 500} 行 · 每 5 秒刷新
      </footer>
    </div>
  )
}
