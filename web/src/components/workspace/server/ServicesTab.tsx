"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Cog,
  Loader2,
  MoreHorizontal,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Search as SearchIcon,
  Square,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useConfirm } from "@/components/admin/use-confirm"
import { VirtualTable } from "@/components/common/virtual-table"
import { cn } from "@/lib/utils"
import { systemdService } from "@/lib/api/services"
import type { SystemdUnit, SystemdVerb } from "@/lib/api/types"

type Props = {
  nodeId: number
  active: boolean
}

type ApiError = { message?: string; detail?: { code?: string } }
type Filter = "all" | "running" | "failed" | "enabled"

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "failed", label: "失败" },
  { value: "enabled", label: "开机自启" },
]

// Maps a typed backend code/message to an actionable operator hint, mirroring
// the firewall tab's language so the dock reads consistently.
function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|root|authentication required|access denied/i.test(msg)) {
    return "SSH 用户无权操作 systemd。换 root 凭据，或为 systemctl 配置 sudoers NOPASSWD。"
  }
  if (code === "no_systemd" || /not available|no systemd/i.test(msg)) {
    return "该节点不是 systemd 发行版（如 Alpine/OpenRC 或精简容器）。"
  }
  if (code === "unreachable") return "节点 SSH 不可达，检查节点状态、代理链与凭据。"
  if (code === "subsystem_unavailable") return "网关二进制未编译服务管理模块，请用最新源码重建网关。"
  return ""
}

function codeOf(e: unknown): string | undefined {
  if (e && typeof e === "object" && "detail" in e) {
    const d = (e as ApiError).detail
    if (d && typeof d === "object" && "code" in d) return String(d.code ?? "") || undefined
  }
  return undefined
}

export function ServicesTab({ nodeId, active }: Props) {
  const qc = useQueryClient()
  const [filter, setFilter] = React.useState<Filter>("all")
  const [search, setSearch] = React.useState("")
  const [detailUnit, setDetailUnit] = React.useState<string | null>(null)
  const { confirm, dialog } = useConfirm()

  const status = useQuery({
    queryKey: ["systemd", nodeId, "status"],
    queryFn: () => systemdService.status(nodeId),
    enabled: active,
    refetchInterval: 30_000,
    retry: false,
  })
  const units = useQuery({
    queryKey: ["systemd", nodeId, "units", filter],
    queryFn: () => systemdService.listUnits(nodeId, filter === "all" ? "" : filter),
    enabled: active && !!status.data?.available,
    refetchInterval: 15_000,
    retry: false,
  })

  const invalidate = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["systemd", nodeId] })
  }, [nodeId, qc])

  const action = useMutation({
    mutationFn: ({ name, verb }: { name: string; verb: SystemdVerb }) =>
      systemdService.action(nodeId, name, verb),
    onSuccess: (_d, vars) => {
      toast.success(`已${verbLabel(vars.verb)} ${shortName(vars.name)}`)
      invalidate()
    },
    onError: (e: ApiError, vars) => {
      const code = codeOf(e)
      toast.error(`${verbLabel(vars.verb)}失败`, {
        description: errorHint(code, e?.message || "") || e?.message,
      })
    },
  })

  const run = React.useCallback(
    async (name: string, verb: SystemdVerb) => {
      // Stop / disable are state-reducing — confirm before firing.
      if (verb === "stop" || verb === "disable") {
        const ok = await confirm({
          title: `${verbLabel(verb)} ${shortName(name)}？`,
          description:
            verb === "stop"
              ? "服务将立即停止，依赖它的服务可能随之中断。"
              : "取消开机自启后，下次重启该服务不会自动拉起（当前运行状态不变）。",
          confirmLabel: verbLabel(verb),
        })
        if (!ok) return
      }
      action.mutate({ name, verb })
    },
    [action, confirm],
  )

  const filtered = React.useMemo(() => {
    const list = units.data?.units ?? []
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (u) => u.name.toLowerCase().includes(q) || u.description.toLowerCase().includes(q),
    )
  }, [units.data, search])

  if (!active) return null

  if (status.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="w-4 h-4 animate-spin" /> 探测 systemd…
      </div>
    )
  }

  if (status.isError || !status.data?.available) {
    const err = status.error as ApiError | undefined
    const code = codeOf(err)
    const msg = status.data?.reason || err?.message || "systemd 不可用"
    return (
      <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
        <Cog className="w-8 h-8 mx-auto opacity-50" />
        <div className="font-medium text-foreground">systemd 不可用</div>
        <div className="text-xs">{msg}</div>
        {errorHint(code, msg) && <div className="text-xs text-foreground/80">{errorHint(code, msg)}</div>}
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => status.refetch()}>
          <RefreshCw className="w-3 h-3" /> 重试
        </Button>
      </div>
    )
  }

  const s = status.data
  return (
    <div className="flex flex-col h-full">
      {dialog}
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-card">
        <div className="flex items-center gap-2 min-w-0">
          <Cog className="w-4 h-4 text-primary shrink-0" />
          <span className="text-xs font-medium shrink-0">systemd {s.version}</span>
          <span className="text-[10px] text-muted-foreground truncate">
            <span className={cn(s.state === "running" ? "text-success" : s.state === "degraded" ? "text-warning" : "")}>
              {s.state || "—"}
            </span>
            {" · "}
            {s.running_units} 运行
            {s.failed_units > 0 && <span className="text-destructive"> · {s.failed_units} 失败</span>}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => invalidate()}
          title="刷新"
        >
          <RefreshCw className={cn("w-3 h-3", (status.isFetching || units.isFetching) && "animate-spin")} />
        </Button>
      </header>

      <div className="px-2 py-1.5 border-b flex items-center gap-1.5">
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="h-7 w-auto min-w-0 gap-1 text-[11px] border-border/60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value} className="text-xs">
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-0">
          <SearchIcon className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="过滤服务名 / 描述…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Badge variant="outline" className="text-[10px] shrink-0">
          {filtered.length}
        </Badge>
      </div>

      <div className="flex-1 overflow-auto">
        {units.isLoading ? (
          <div className="text-xs text-muted-foreground p-6 inline-flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> 加载服务…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground p-6 text-center">无匹配服务</div>
        ) : (
          <VirtualTable
            rows={filtered}
            empty="无匹配服务"
            header={
              <>
                <th className="px-2 py-1.5 text-left">服务</th>
                <th className="w-16 px-2 py-1.5 text-left">状态</th>
                <th className="w-14 px-2 py-1.5 text-left">自启</th>
                <th className="w-24 px-2 py-1.5 text-right">操作</th>
              </>
            }
            renderRow={(u) => (
              <UnitRow
                u={u}
                busy={action.isPending}
                onAction={run}
                onDetail={() => setDetailUnit(u.name)}
              />
            )}
          />
        )}
      </div>

      <DetailSheet nodeId={nodeId} unit={detailUnit} onClose={() => setDetailUnit(null)} />
    </div>
  )
}

function UnitRow({
  u,
  busy,
  onAction,
  onDetail,
}: {
  u: SystemdUnit
  busy: boolean
  onAction: (name: string, verb: SystemdVerb) => void
  onDetail: () => void
}) {
  const running = u.active === "active"
  return (
    <>
      <td className="min-w-0 px-2 py-1.5 align-top">
        <button
          type="button"
          onClick={onDetail}
          className="block max-w-[12rem] truncate text-left font-medium hover:text-primary"
          title={u.name}
        >
          {u.name}
        </button>
        {u.description && (
          <div className="text-[10px] text-muted-foreground truncate max-w-[12rem]" title={u.description}>
            {u.description}
          </div>
        )}
      </td>
      <td className="px-2 py-1.5">
        <Badge variant={activeVariant(u.active)} className="text-[10px]">
          {u.active}
        </Badge>
        {u.sub && u.sub !== u.active && (
          <div className="text-[10px] text-muted-foreground mt-0.5">{u.sub}</div>
        )}
      </td>
      <td className="px-2 py-1.5">
        <EnabledChip enabled={u.enabled} />
      </td>
      <td className="px-2 py-1.5 text-right">
        <div className="inline-flex gap-0.5">
          {running ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="停止"
              disabled={busy}
              onClick={() => onAction(u.name, "stop")}
            >
              <Square className="w-3 h-3" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="启动"
              disabled={busy}
              onClick={() => onAction(u.name, "start")}
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
            onClick={() => onAction(u.name, "restart")}
          >
            <RotateCw className="w-3 h-3" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" title="更多" disabled={busy}>
                <MoreHorizontal className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onClick={() => onAction(u.name, "reload")}>
                <RefreshCw className="w-3.5 h-3.5" /> 重载配置
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {u.enabled === "enabled" ? (
                <DropdownMenuItem onClick={() => onAction(u.name, "disable")}>
                  <PowerOff className="w-3.5 h-3.5" /> 取消开机自启
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => onAction(u.name, "enable")}>
                  <Power className="w-3.5 h-3.5" /> 设为开机自启
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </>
  )
}

function activeVariant(state: string): "success" | "destructive" | "warning" | "secondary" {
  switch (state) {
    case "active":
      return "success"
    case "failed":
      return "destructive"
    case "activating":
    case "deactivating":
    case "reloading":
      return "warning"
    default:
      return "secondary"
  }
}

function EnabledChip({ enabled }: { enabled: string }) {
  if (!enabled) return <span className="text-[10px] text-muted-foreground">—</span>
  const tone =
    enabled === "enabled"
      ? "text-success"
      : enabled === "masked"
        ? "text-destructive"
        : "text-muted-foreground"
  return <span className={cn("text-[10px]", tone)} title={enabled}>{enabled}</span>
}

function DetailSheet({
  nodeId,
  unit,
  onClose,
}: {
  nodeId: number
  unit: string | null
  onClose: () => void
}) {
  const detail = useQuery({
    queryKey: ["systemd", nodeId, "detail", unit],
    queryFn: () => systemdService.detail(nodeId, unit as string, 300),
    enabled: !!unit,
    refetchInterval: 10_000,
    retry: false,
  })
  const d = detail.data

  return (
    <Sheet open={!!unit} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[min(560px,calc(100vw-2rem))] sm:max-w-none flex flex-col gap-3">
        <SheetHeader>
          <SheetTitle className="truncate" title={unit || ""}>
            {unit}
          </SheetTitle>
          <SheetDescription>{d?.unit.description || "服务详情与日志"}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-1 space-y-4">
          {detail.isLoading && (
            <div className="text-xs text-muted-foreground inline-flex items-center gap-2 py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载…
            </div>
          )}
          {detail.isError && (
            <div className="text-xs text-destructive break-words py-2">
              {(detail.error as ApiError)?.message || "加载失败"}
            </div>
          )}
          {d && (
            <>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant={activeVariant(d.unit.active)} className="text-[10px]">
                  {d.unit.active}
                  {d.unit.sub && d.unit.sub !== d.unit.active ? ` · ${d.unit.sub}` : ""}
                </Badge>
                {d.unit.enabled && (
                  <Badge variant="outline" className="text-[10px]">{d.unit.enabled}</Badge>
                )}
                {d.unit.load && (
                  <Badge variant="outline" className="text-[10px]">{d.unit.load}</Badge>
                )}
              </div>

              <dl className="text-[11px] grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5">
                {d.main_pid ? <Field k="主进程 PID" v={String(d.main_pid)} mono /> : null}
                {d.memory_bytes ? <Field k="内存占用" v={fmtBytes(d.memory_bytes)} mono /> : null}
                {d.tasks_current ? <Field k="任务/线程" v={String(d.tasks_current)} mono /> : null}
                {d.active_since ? <Field k="活跃自" v={d.active_since} /> : null}
                {d.properties?.FragmentPath ? (
                  <Field k="单元文件" v={d.properties.FragmentPath} mono />
                ) : null}
                {d.properties?.Restart ? <Field k="重启策略" v={d.properties.Restart} mono /> : null}
                {d.properties?.Documentation ? (
                  <Field k="文档" v={d.properties.Documentation} />
                ) : null}
              </dl>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    最近日志（journalctl）
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => detail.refetch()}
                    title="刷新日志"
                  >
                    <RefreshCw className={cn("w-3 h-3", detail.isFetching && "animate-spin")} />
                  </Button>
                </div>
                <pre className="bg-muted/60 rounded-md p-2 text-[11px] font-mono whitespace-pre-wrap break-words leading-5 max-h-[44vh] overflow-auto">
                  {d.journal || "（无日志或当前用户无权读取 journal）"}
                </pre>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("truncate", mono && "font-mono")} title={v}>
        {v}
      </dd>
    </>
  )
}

function verbLabel(v: SystemdVerb): string {
  return (
    { start: "启动", stop: "停止", restart: "重启", reload: "重载", enable: "启用自启", disable: "取消自启" }[v] ??
    v
  )
}

function shortName(name: string): string {
  return name.replace(/\.service$/, "")
}

function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = b
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`
}
