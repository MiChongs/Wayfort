"use client"

// Port-forwards listing + create surface. Phase 7 redesign: shadcn Card
// grid powered by the live PortForwardEventsProvider, with search, batch
// delete, TTL presets, label/tag editor, and per-row sparklines from the
// shared insights component. The legacy <table> is gone — the row layout
// is now a responsive grid of ForwardLiveCard tiles so the byte-rate
// counters can update at WS cadence without flickering the entire DOM.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ForwardLiveCard } from "@/components/portfwd/ForwardLiveCard"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import {
  PortForwardEventsProvider,
  useForwardEventsLatency,
  useForwardEventsStatus,
} from "@/hooks/use-portfwd-events"
import { meService, portfwdService } from "@/lib/api/services"
import type { PortForward } from "@/lib/api/types"

type StatusFilter = "all" | PortForward["status"]

const TTL_PRESETS: Array<{ label: string; value: string }> = [
  { label: "1 小时", value: "1h" },
  { label: "6 小时", value: "6h" },
  { label: "24 小时", value: "24h" },
  { label: "7 天", value: "168h" },
]

export default function PortForwardsPage() {
  return (
    <PortForwardEventsProvider>
      <Inner />
    </PortForwardEventsProvider>
  )
}

function Inner() {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["portfwd"],
    queryFn: portfwdService.list,
  })
  const nodes = useQuery({
    queryKey: ["me", "nodes"],
    queryFn: meService.visibleNodes,
  })
  const eventsStatus = useForwardEventsStatus()
  const eventsLatency = useForwardEventsLatency()

  const [createOpen, setCreateOpen] = React.useState(false)
  const [nodeId, setNodeId] = React.useState("")
  const [ttl, setTtl] = React.useState("1h")
  const [label, setLabel] = React.useState("")
  const [tagsInput, setTagsInput] = React.useState("")
  const [pinned, setPinned] = React.useState(false)

  const [search, setSearch] = React.useState("")
  const [status, setStatus] = React.useState<StatusFilter>("all")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  const create = useMutation({
    mutationFn: () =>
      portfwdService.create({
        node_id: Number(nodeId),
        ttl: ttl || undefined,
        label: label.trim() || undefined,
        tags: tagsInput
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        pinned,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["portfwd"] })
      setCreateOpen(false)
      setLabel("")
      setTagsInput("")
      setPinned(false)
      toast.success("已开端口转发")
    },
    onError: (e: { message?: string }) =>
      toast.error("申请失败", { description: e?.message }),
  })

  const close = useMutation({
    mutationFn: (id: string) => portfwdService.remove(id),
    onError: (e: { message?: string }) =>
      toast.error("释放失败", { description: e?.message }),
  })

  const allForwards = React.useMemo<PortForward[]>(
    () => list.data?.port_forwards ?? [],
    [list.data],
  )

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    return allForwards.filter((p) => {
      if (status !== "all" && p.status !== status) return false
      if (!term) return true
      if (p.label?.toLowerCase().includes(term)) return true
      if (p.target_host?.toLowerCase().includes(term)) return true
      if (`${p.local_host}:${p.local_port}`.toLowerCase().includes(term)) return true
      if (p.tags?.some((t) => t.toLowerCase().includes(term))) return true
      return false
    })
  }, [allForwards, search, status])

  const sorted = React.useMemo(() => {
    return [...filtered].sort((a, b) => {
      if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0)) return a.pinned ? -1 : 1
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [filtered])

  const selectedCount = selected.size
  const visibleIds = React.useMemo(() => new Set(sorted.map((p) => p.id)), [sorted])

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  const selectAllVisible = () => {
    if (selectedCount === visibleIds.size && visibleIds.size > 0) {
      clearSelection()
      return
    }
    setSelected(new Set(visibleIds))
  }

  const batchDelete = async () => {
    if (selectedCount === 0) return
    const ok = await confirmDialog({
      title: `批量释放 ${selectedCount} 个转发?`,
      description: "操作不可撤销。",
    })
    if (!ok) return
    let failures = 0
    for (const id of selected) {
      try {
        await close.mutateAsync(id)
      } catch {
        failures++
      }
    }
    clearSelection()
    await qc.invalidateQueries({ queryKey: ["portfwd"] })
    if (failures > 0) {
      toast.error(`释放失败 ${failures} 个`)
    } else {
      toast.success(`已批量释放 ${selectedCount} 个`)
    }
  }

  return (
    <div className="p-6 space-y-4">
      <Header
        eventsStatus={eventsStatus}
        eventsLatency={eventsLatency}
        onRefresh={() => list.refetch()}
        refreshing={list.isFetching}
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        nodeId={nodeId}
        setNodeId={setNodeId}
        nodes={nodes.data?.nodes ?? []}
        ttl={ttl}
        setTtl={setTtl}
        label={label}
        setLabel={setLabel}
        tagsInput={tagsInput}
        setTagsInput={setTagsInput}
        pinned={pinned}
        setPinned={setPinned}
        creating={create.isPending}
        onCreate={() => create.mutate()}
      />

      <Toolbar
        search={search}
        setSearch={setSearch}
        status={status}
        setStatus={setStatus}
        total={allForwards.length}
        visible={sorted.length}
        selectedCount={selectedCount}
        onSelectAll={selectAllVisible}
        allVisibleSelected={selectedCount === visibleIds.size && visibleIds.size > 0}
        onClearSelection={clearSelection}
        onBatchDelete={batchDelete}
      />

      {list.isLoading ? (
        <div className="rounded-lg border p-10 text-center text-sm text-muted-foreground inline-flex items-center gap-2 w-full justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Share2}
          title={
            allForwards.length === 0
              ? "还没有活动转发"
              : "没有匹配的转发"
          }
          description={
            allForwards.length === 0
              ? "点「新建」选一个节点，把目标的 TCP 端口暴露到网关本地 127.0.0.1。"
              : "调整搜索关键字或筛选条件。"
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <AnimatePresence initial={false}>
            {sorted.map((p) => (
              <motion.div
                key={p.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="relative"
              >
                <div className="absolute top-3 left-3 z-10">
                  <Checkbox
                    checked={selected.has(p.id)}
                    onCheckedChange={() => toggleSelected(p.id)}
                    aria-label="选择"
                  />
                </div>
                <div className="pl-7">
                  <ForwardLiveCard forward={p} />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}

interface HeaderProps {
  eventsStatus: ReturnType<typeof useForwardEventsStatus>
  eventsLatency: number | null
  onRefresh: () => void
  refreshing: boolean
  createOpen: boolean
  setCreateOpen: (open: boolean) => void
  nodeId: string
  setNodeId: (id: string) => void
  nodes: Array<{ id: number; name: string; host: string; port: number; protocol: string }>
  ttl: string
  setTtl: (v: string) => void
  label: string
  setLabel: (v: string) => void
  tagsInput: string
  setTagsInput: (v: string) => void
  pinned: boolean
  setPinned: (v: boolean) => void
  creating: boolean
  onCreate: () => void
}

function Header(props: HeaderProps) {
  const liveBadge =
    props.eventsStatus === "open"
      ? {
          tone: "success" as const,
          icon: <Wifi className="w-3 h-3" />,
          label:
            props.eventsLatency !== null
              ? `实时 · ${props.eventsLatency}ms`
              : "实时",
        }
      : props.eventsStatus === "connecting"
        ? {
            tone: "outline" as const,
            icon: <Loader2 className="w-3 h-3 animate-spin" />,
            label: "连接中",
          }
        : {
            tone: "destructive" as const,
            icon: <WifiOff className="w-3 h-3" />,
            label: props.eventsStatus === "error" ? "事件流断开" : "已断开",
          }

  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Share2 className="w-5 h-5" /> 端口转发
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          在网关本地开监听，把流量转到目标节点。适合 mysql / RDP / 任意 TCP，本地客户端直接连
          <code className="font-mono mx-1">127.0.0.1:&lt;port&gt;</code>。
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant={liveBadge.tone} className="gap-1">
              {liveBadge.icon}
              {liveBadge.label}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>事件流 WebSocket 状态</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={props.onRefresh}>
          <RefreshCw className={`w-4 h-4 ${props.refreshing ? "animate-spin" : ""}`} /> 刷新
        </Button>
        <Dialog open={props.createOpen} onOpenChange={props.setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4" /> 新建
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>申请端口转发</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>目标节点</Label>
                <Select value={props.nodeId} onValueChange={props.setNodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择一个节点" />
                  </SelectTrigger>
                  <SelectContent>
                    {props.nodes.map((n) => (
                      <SelectItem key={n.id} value={String(n.id)}>
                        {n.name} ({n.host}:{n.port}) · {n.protocol}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>有效期</Label>
                <div className="flex items-center gap-2 flex-wrap">
                  <ToggleGroup
                    type="single"
                    value={props.ttl}
                    onValueChange={(v) => v && props.setTtl(v)}
                    variant="outline"
                    size="sm"
                  >
                    {TTL_PRESETS.map((preset) => (
                      <ToggleGroupItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <Input
                    value={props.ttl}
                    onChange={(e) => props.setTtl(e.target.value)}
                    placeholder="自定义，如 90m"
                    className="h-9 w-32"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>标签 (可选)</Label>
                <Input
                  value={props.label}
                  onChange={(e) => props.setLabel(e.target.value)}
                  placeholder="如 staging-db"
                />
              </div>
              <div className="space-y-1">
                <Label>标记 (逗号分隔)</Label>
                <Input
                  value={props.tagsInput}
                  onChange={(e) => props.setTagsInput(e.target.value)}
                  placeholder="如 prod, mysql"
                />
              </div>
              <label className="inline-flex items-center gap-2 text-sm">
                <Checkbox
                  checked={props.pinned}
                  onCheckedChange={(v) => props.setPinned(v === true)}
                />
                创建后立即置顶
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => props.setCreateOpen(false)}>
                取消
              </Button>
              <Button
                disabled={!props.nodeId || props.creating}
                onClick={props.onCreate}
              >
                {props.creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                申请
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

interface ToolbarProps {
  search: string
  setSearch: (v: string) => void
  status: StatusFilter
  setStatus: (v: StatusFilter) => void
  total: number
  visible: number
  selectedCount: number
  allVisibleSelected: boolean
  onSelectAll: () => void
  onClearSelection: () => void
  onBatchDelete: () => void
}

function Toolbar(props: ToolbarProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap rounded-lg border bg-card/40 p-2">
      <div className="relative flex-1 min-w-[180px]">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          value={props.search}
          onChange={(e) => props.setSearch(e.target.value)}
          placeholder="按标签 / 地址 / 标记搜索"
          className="h-8 pl-7"
        />
      </div>
      <ToggleGroup
        type="single"
        value={props.status}
        onValueChange={(v) => v && props.setStatus(v as StatusFilter)}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="all">全部</ToggleGroupItem>
        <ToggleGroupItem value="active">活动</ToggleGroupItem>
        <ToggleGroupItem value="expired">过期</ToggleGroupItem>
        <ToggleGroupItem value="closed">已关闭</ToggleGroupItem>
        <ToggleGroupItem value="port_unavailable">端口占用</ToggleGroupItem>
      </ToggleGroup>
      <div className="text-xs text-muted-foreground">
        {props.visible} / {props.total}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={props.onSelectAll}>
          <Checkbox
            checked={props.allVisibleSelected}
            className="mr-1 pointer-events-none"
            aria-hidden
          />
          全选当前
        </Button>
        {props.selectedCount > 0 ? (
          <>
            <Badge variant="outline">已选 {props.selectedCount}</Badge>
            <Button variant="ghost" size="sm" onClick={props.onClearSelection}>
              清除
            </Button>
            <Button variant="destructive" size="sm" onClick={props.onBatchDelete}>
              <Trash2 className="w-3.5 h-3.5" /> 批量释放
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
