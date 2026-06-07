"use client"

// 代理链画布 —— ComfyUI 式的节点工作流编排。把一条代理链画成
// 「客户端 → 中转节点 …… → 目标」的节点图：拖拽节点、在端口之间连线即可
// 编排顺序，链路顺序由连线推导。支持平移 / 缩放 / 小地图、左侧节点库拖入、
// 实时校验与真实连通测试。
//
// 链路仍以 "1,2,3"（代理 id 逗号分隔）对外存储，保持与后端字段一致。

import * as React from "react"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useMutation } from "@tanstack/react-query"
import {
  CheckCircle2,
  CircleSlash,
  Monitor,
  Plus,
  ServerCog,
  Target,
  Trash2,
  Wifi,
  Zap,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { proxyService } from "@/lib/api/services"
import type { ChainHopTestResult, ChainIssue, Proxy, ProxyKind } from "@/lib/api/types"

const KIND_LABEL: Record<ProxyKind, string> = {
  direct: "直连",
  socks5: "SOCKS5",
  bastion: "SSH 跳板",
  http_connect: "HTTP 代理",
}

const KIND_TONE: Record<ProxyKind, string> = {
  direct: "bg-muted text-muted-foreground border-border",
  socks5: "bg-sky-500/10 text-sky-600 dark:text-sky-300 border-sky-500/30",
  bastion: "bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/30",
  http_connect: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
}

const CLIENT_ID = "client"
const TARGET_ID = "target"
const COL_W = 240 // 横向自动排布的列距
const ROW_Y = 80

// ---- 节点数据 --------------------------------------------------------------

interface HopNodeData extends Record<string, unknown> {
  proxy?: Proxy
  proxyId: number
  inChain: boolean
  issue?: ChainIssue
  test?: ChainHopTestResult
  onRemove: (id: number) => void
}

// ---- 自定义节点 ------------------------------------------------------------

function ClientNode() {
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <Monitor className="h-4 w-4 text-primary" />
        <div className="text-sm font-medium">客户端 / 网关</div>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">会话从这里发起</div>
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
    </div>
  )
}

function TargetNode({ data }: NodeProps) {
  const addr = (data as { addr?: string }).addr
  return (
    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-background !bg-emerald-500" />
      <div className="flex items-center gap-2">
        <Target className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <div className="text-sm font-medium">目标节点</div>
      </div>
      <div className="mt-0.5 font-mono text-xs text-muted-foreground">{addr || "连接的资产"}</div>
    </div>
  )
}

function HopNode({ data }: NodeProps) {
  const d = data as HopNodeData
  const p = d.proxy
  const error = d.issue?.severity === "error" || !p
  return (
    <div
      className={cn(
        "group w-[208px] rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-colors",
        error && "border-destructive/40 ring-1 ring-destructive/15",
        !d.inChain && "opacity-55",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-background !bg-foreground/60" />
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ServerCog className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{p ? p.name : `代理 #${d.proxyId}`}</span>
        </div>
        <button
          type="button"
          onClick={() => d.onRemove(d.proxyId)}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="移除该节点"
          aria-label="移除该节点"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {p ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className={cn("font-normal", KIND_TONE[p.kind])}>
            {KIND_LABEL[p.kind]}
          </Badge>
          {p.host ? <span className="font-mono text-[11px] text-muted-foreground">{p.host}:{p.port}</span> : null}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-destructive">该代理已被删除，请移除此节点</div>
      )}

      {!d.inChain && p ? <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">未接入链路</div> : null}
      {d.issue && p ? (
        <div className={cn("mt-1 text-[11px]", d.issue.severity === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400")}>
          {d.issue.message}
        </div>
      ) : null}
      {d.test ? (
        <div className={cn("mt-1 text-[11px]", d.test.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
          {d.test.ok ? `连通 · ${d.test.duration_ms}ms` : `失败：${d.test.error || "建链未成功"}`}
        </div>
      ) : null}
    </div>
  )
}

const NODE_TYPES = { client: ClientNode, hop: HopNode, target: TargetNode }

// ---- 链路推导 --------------------------------------------------------------

// chainFromEdges 沿 client → … → target 的单向连线走出代理 id 序列。
function chainFromEdges(edges: Edge[]): number[] {
  const nextOf = new Map<string, string>()
  for (const e of edges) {
    // 每个源只取第一条出边（onConnect 已保证单出单入）。
    if (!nextOf.has(e.source)) nextOf.set(e.source, e.target)
  }
  const out: number[] = []
  const seen = new Set<string>([CLIENT_ID])
  let cur = nextOf.get(CLIENT_ID)
  while (cur && cur !== TARGET_ID && !seen.has(cur)) {
    seen.add(cur)
    const id = Number(cur.replace("hop-", ""))
    if (Number.isFinite(id)) out.push(id)
    cur = nextOf.get(cur)
  }
  return out
}

function parseChainIds(s: string): number[] {
  if (!s) return []
  const out: number[] = []
  for (const raw of s.split(",")) {
    const n = Number(raw.trim())
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return out
}

// 把一条链 + 全部代理布成左→右的初始节点 / 连线。
function layoutFromChain(ids: number[], proxyById: Map<number, Proxy>, addr?: string): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: CLIENT_ID, type: "client", position: { x: 0, y: ROW_Y }, data: {}, deletable: false },
  ]
  const edges: Edge[] = []
  let prev = CLIENT_ID
  ids.forEach((id, i) => {
    const nodeId = `hop-${id}`
    nodes.push({
      id: nodeId,
      type: "hop",
      position: { x: COL_W * (i + 1), y: ROW_Y },
      data: { proxyId: id, proxy: proxyById.get(id), inChain: true } as HopNodeData,
    })
    edges.push({ id: `${prev}->${nodeId}`, source: prev, target: nodeId, animated: true })
    prev = nodeId
  })
  nodes.push({
    id: TARGET_ID,
    type: "target",
    position: { x: COL_W * (ids.length + 1), y: ROW_Y },
    data: { addr },
    deletable: false,
  })
  edges.push({ id: `${prev}->${TARGET_ID}`, source: prev, target: TARGET_ID, animated: true })
  return { nodes, edges }
}

// ---- 主组件 ----------------------------------------------------------------

export interface ProxyChainCanvasProps {
  value: string
  onChange: (next: string) => void
  proxies: Proxy[]
  target?: string
  disabled?: boolean
  className?: string
}

export function ProxyChainCanvas(props: ProxyChainCanvasProps) {
  return (
    <ReactFlowProvider>
      <ChainCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function ChainCanvasInner({ value, onChange, proxies, target, disabled, className }: ProxyChainCanvasProps) {
  const proxyById = React.useMemo(() => new Map(proxies.map((p) => [p.id, p])), [proxies])
  // Seeded with the initial chain so the mount-time value-sync effect doesn't
  // re-lay-out what we already laid out from `value`.
  const lastEmitted = React.useRef<string>(value)

  const initial = React.useMemo(
    () => layoutFromChain(parseChainIds(value), proxyById, target),
    // 仅在挂载时布一次；后续编辑走内部状态，外部 value 变化由下方 effect 同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)

  const [issues, setIssues] = React.useState<ChainIssue[]>([])
  const [testResults, setTestResults] = React.useState<ChainHopTestResult[] | null>(null)

  const onRemove = React.useCallback(
    (id: number) => {
      setNodes((nds) => nds.filter((n) => n.id !== `hop-${id}`))
      setEdges((eds) => reconnectAround(eds, `hop-${id}`))
    },
    // setters are stable; the edges→onChange effect below emits the new chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // 外部 value 变化（套用模板 / 重置）→ 重新布图。跳过自己刚发出的值。
  React.useEffect(() => {
    if (value === lastEmitted.current) return
    const next = layoutFromChain(parseChainIds(value), proxyById, target)
    setNodes(next.nodes)
    setEdges(next.edges)
    setTestResults(null)
  }, [value, proxyById, target, setNodes, setEdges])

  // 单一数据源：连线 / 删除 / 重排都只改 edges 状态；下面的 effect 统一从图
  // 推导链路并回传父组件，避免在 setState 更新函数里产生副作用。
  React.useEffect(() => {
    const chain = chainFromEdges(edges).join(",")
    lastEmitted.current = chain
    onChange(chain)
  }, [edges, onChange])

  const onConnect = React.useCallback(
    (conn: Connection) => {
      // 单出单入：移除同源出边与同目标入边后再连。
      setEdges((eds) =>
        addEdge({ ...conn, animated: true }, eds.filter((e) => e.source !== conn.source && e.target !== conn.target)),
      )
    },
    [setEdges],
  )

  // 节点库点击 → 追加到链尾（自动接到 target 前）。
  const appendHop = React.useCallback(
    (id: number) => {
      const nodeId = `hop-${id}`
      setNodes((nds) => {
        if (nds.some((n) => n.id === nodeId)) {
          toast.warning("该代理已在画布上")
          return nds
        }
        const hopCount = nds.filter((n) => n.type === "hop").length
        return [
          ...nds,
          {
            id: nodeId,
            type: "hop",
            position: { x: COL_W * (hopCount + 1), y: ROW_Y + 140 },
            data: { proxyId: id, proxy: proxyById.get(id), inChain: true } as HopNodeData,
          },
        ]
      })
      setEdges((eds) => {
        const feed = eds.find((e) => e.target === TARGET_ID)
        const prev = feed ? feed.source : CLIENT_ID
        return eds
          .filter((e) => e.target !== TARGET_ID)
          .concat([
            { id: `${prev}->${nodeId}`, source: prev, target: nodeId, animated: true },
            { id: `${nodeId}->${TARGET_ID}`, source: nodeId, target: TARGET_ID, animated: true },
          ])
      })
    },
    [setNodes, setEdges, proxyById],
  )

  // 实时校验（防抖）。
  React.useEffect(() => {
    const chain = chainFromEdges(edges).join(",")
    if (!chain) {
      setIssues([])
      return
    }
    const h = setTimeout(async () => {
      try {
        const r = await proxyService.validateChain(chain)
        setIssues(r.issues || [])
      } catch {
        setIssues([])
      }
    }, 350)
    return () => clearTimeout(h)
  }, [edges])

  // 真实连通测试。
  const test = useMutation({
    mutationFn: () => proxyService.testChain(chainFromEdges(edges).join(","), target || ""),
    onMutate: () => setTestResults(null),
    onSuccess: (r) => {
      setTestResults(r.results || [])
      if (r.ok) toast.success("链路连通", { description: target ? `已到达 ${target}` : "每个中转都建链成功" })
      else toast.error("链路不通", { description: r.results?.find((x) => !x.ok)?.error || "查看节点上的失败原因" })
    },
    onError: (e: Error) => toast.error("测试请求失败", { description: e.message }),
  })

  // 把校验 / 测试结果与 inChain 状态回填进节点 data。
  const chainSet = React.useMemo(() => new Set(chainFromEdges(edges).map((id) => `hop-${id}`)), [edges])
  const decoratedNodes = React.useMemo(
    () =>
      nodes.map((n) => {
        if (n.type !== "hop") return n
        const d = n.data as HopNodeData
        const idx = chainFromEdges(edges).indexOf(d.proxyId)
        return {
          ...n,
          data: {
            ...d,
            proxy: proxyById.get(d.proxyId),
            inChain: chainSet.has(n.id),
            issue: issues.find((i) => i.hop === idx) ?? issues.find((i) => i.hop < 0),
            test: testResults?.find((t) => t.hop === idx),
            onRemove,
          } as HopNodeData,
        }
      }),
    [nodes, edges, chainSet, issues, testResults, proxyById, onRemove],
  )

  const chainIds = chainFromEdges(edges)
  const errorCount = issues.filter((i) => i.severity === "error").length
  const candidates = proxies.filter((p) => !p.disabled && !nodes.some((n) => n.id === `hop-${p.id}`))

  return (
    <div className={cn("relative h-full w-full overflow-hidden rounded-lg border bg-muted/20", className)}>
      <ReactFlow
        nodes={decoratedNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={NODE_TYPES}
        nodesConnectable={!disabled}
        nodesDraggable={!disabled}
        elementsSelectable={!disabled}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="opacity-60" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-card" nodeStrokeWidth={2} />

        {/* 节点库 */}
        <Panel position="top-left" className="!m-2">
          <div className="w-56 rounded-lg border bg-card/95 shadow-sm backdrop-blur">
            <div className="border-b px-3 py-2 text-xs font-medium">节点库</div>
            <div className="max-h-56 overflow-auto p-1.5">
              {candidates.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">没有可添加的代理</div>
              ) : (
                candidates.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => appendHop(p.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <Badge variant="outline" className={cn("shrink-0 text-[10px] font-normal", KIND_TONE[p.kind])}>
                      {KIND_LABEL[p.kind]}
                    </Badge>
                  </button>
                ))
              )}
            </div>
          </div>
        </Panel>

        {/* 状态条 + 测试 */}
        <Panel position="top-right" className="!m-2">
          <div className="flex items-center gap-2 rounded-lg border bg-card/95 px-3 py-1.5 shadow-sm backdrop-blur">
            {chainIds.length === 0 ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <CircleSlash className="h-3.5 w-3.5" /> 直连（未经过任何中转）
              </span>
            ) : errorCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-xs text-destructive">
                <Wifi className="h-3.5 w-3.5" /> {chainIds.length} 个中转 · {errorCount} 处错误
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> 经过 {chainIds.length} 个中转，链路有效
              </span>
            )}
            <div className="h-4 w-px bg-border" />
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={disabled || chainIds.length === 0 || test.isPending}
              onClick={() => test.mutate()}
            >
              <Zap className={cn("h-3.5 w-3.5", test.isPending && "animate-pulse")} /> 测试连通
            </Button>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  )
}

// reconnectAround 删除某节点时，把它的上游接到下游，保持链不断。
function reconnectAround(edges: Edge[], nodeId: string): Edge[] {
  const incoming = edges.find((e) => e.target === nodeId)
  const outgoing = edges.find((e) => e.source === nodeId)
  const rest = edges.filter((e) => e.source !== nodeId && e.target !== nodeId)
  if (incoming && outgoing) {
    rest.push({
      id: `${incoming.source}->${outgoing.target}`,
      source: incoming.source,
      target: outgoing.target,
      animated: true,
    })
  }
  return rest
}
