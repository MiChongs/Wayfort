"use client"

// 洞察:底部「生效预览」条(可连台数/权限分布/限期/成员继承) + 可视化对话框
// (recharts Treemap 资产分布 + @xyflow/react 访问关系图)。

import * as React from "react"
import { ResponsiveContainer, Tooltip, Treemap } from "recharts"
import { ReactFlow, Background, Controls, Position, type Edge, type Node as RFNode } from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { BarChart3, Clock, Network, Server } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { actionLabel } from "@/lib/access/permissions"
import { computeInsight } from "./tree-model"
import type { AccessFolder, AccessItem, GranteeKind, Node } from "@/lib/api/types"

const KIND_LABEL: Record<string, string> = { user: "用户", group: "用户组", department: "部门" }

export function PreviewStrip({
  folders,
  items,
  ownerType,
  onOpenInsight,
}: {
  folders: AccessFolder[]
  items: AccessItem[]
  ownerType: GranteeKind
  onOpenInsight: () => void
}) {
  const folderById = React.useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  const ins = React.useMemo(() => computeInsight(items, folderById), [items, folderById])
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/20 px-3 py-2 text-xs">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Server className="h-3.5 w-3.5 text-muted-foreground" /> 可连 {ins.assets} 台
      </span>
      <span className="text-muted-foreground">文件夹 {folders.length}</span>
      {ins.expiring > 0 ? (
        <span className="inline-flex items-center gap-1 text-warning">
          <Clock className="h-3.5 w-3.5" /> 限期 {ins.expiring}
        </span>
      ) : null}
      <span className="flex flex-wrap gap-1">
        {Object.entries(ins.byAction)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([a, n]) => (
            <Badge key={a} variant="secondary" className="font-normal text-[10px]">
              {actionLabel(a)} {n}
            </Badge>
          ))}
      </span>
      {ownerType !== "user" ? <span className="text-muted-foreground">· {KIND_LABEL[ownerType]}成员继承此目录</span> : null}
      <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1.5 text-xs" onClick={onOpenInsight} disabled={items.length === 0}>
        <BarChart3 className="h-3.5 w-3.5" /> 可视化
      </Button>
    </div>
  )
}

// ---- visualization dialog ----

interface TreeDatum {
  name: string
  size?: number
  children?: TreeDatum[]
  [k: string]: unknown
}

function buildTreemap(folders: AccessFolder[], items: AccessItem[]): TreeDatum[] {
  const folderIds = new Set(folders.map((f) => f.id))
  const childrenOf = new Map<number, AccessFolder[]>()
  for (const f of folders) {
    const key = f.parent_id != null && folderIds.has(f.parent_id) ? f.parent_id : 0
    const arr = childrenOf.get(key) ?? []
    arr.push(f)
    childrenOf.set(key, arr)
  }
  const countByFolder = new Map<number, number>()
  for (const it of items) countByFolder.set(it.folder_id, (countByFolder.get(it.folder_id) ?? 0) + 1)
  const make = (f: AccessFolder): TreeDatum => {
    const kids = (childrenOf.get(f.id) ?? []).map(make)
    const own = countByFolder.get(f.id) ?? 0
    return own > 0 || kids.length === 0 ? { name: f.name, size: Math.max(own, 1), children: kids.length ? kids : undefined } : { name: f.name, children: kids }
  }
  return (childrenOf.get(0) ?? []).map(make)
}

function buildGraph(folders: AccessFolder[], items: AccessItem[], nodeById: Map<number, Node>, ownerName: string) {
  const folderIds = new Set(folders.map((f) => f.id))
  const childrenOf = new Map<number, AccessFolder[]>()
  for (const f of folders) {
    const key = f.parent_id != null && folderIds.has(f.parent_id) ? f.parent_id : 0
    const arr = childrenOf.get(key) ?? []
    arr.push(f)
    childrenOf.set(key, arr)
  }
  const itemsByFolder = new Map<number, AccessItem[]>()
  for (const it of items) {
    const arr = itemsByFolder.get(it.folder_id) ?? []
    arr.push(it)
    itemsByFolder.set(it.folder_id, arr)
  }
  const rfNodes: RFNode[] = []
  const edges: Edge[] = []
  const yByDepth = new Map<number, number>()
  const place = (depth: number) => {
    const y = yByDepth.get(depth) ?? 0
    yByDepth.set(depth, y + 56)
    return { x: depth * 220, y }
  }
  rfNodes.push({ id: "owner", position: place(0), data: { label: ownerName }, style: ownerStyle, sourcePosition: Position.Right, targetPosition: Position.Left })
  const walk = (parentFolderId: number, parentNodeId: string, depth: number) => {
    for (const f of childrenOf.get(parentFolderId) ?? []) {
      const id = `f${f.id}`
      rfNodes.push({ id, position: place(depth), data: { label: f.name }, style: folderStyle, sourcePosition: Position.Right, targetPosition: Position.Left })
      edges.push({ id: `${parentNodeId}-${id}`, source: parentNodeId, target: id })
      walk(f.id, id, depth + 1)
      for (const it of itemsByFolder.get(f.id) ?? []) {
        const nid = `i${it.id}`
        rfNodes.push({ id: nid, position: place(depth + 1), data: { label: nodeById.get(it.node_id)?.name ?? `#${it.node_id}` }, style: assetStyle, targetPosition: Position.Left })
        edges.push({ id: `${id}-${nid}`, source: id, target: nid })
      }
    }
  }
  walk(0, "owner", 1)
  return { rfNodes, edges }
}

const baseStyle = { borderRadius: 8, fontSize: 12, padding: "6px 10px", border: "1px solid var(--border)" } as const
const ownerStyle = { ...baseStyle, background: "var(--primary)", color: "var(--primary-foreground)", fontWeight: 600 }
const folderStyle = { ...baseStyle, background: "var(--muted)", color: "var(--foreground)" }
const assetStyle = { ...baseStyle, background: "var(--card)", color: "var(--muted-foreground)" }

export function InsightDialog({
  open,
  onOpenChange,
  folders,
  items,
  nodeById,
  ownerName,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  folders: AccessFolder[]
  items: AccessItem[]
  nodeById: Map<number, Node>
  ownerName: string
}) {
  const treemap = React.useMemo(() => buildTreemap(folders, items), [folders, items])
  const graph = React.useMemo(() => buildGraph(folders, items, nodeById, ownerName), [folders, items, nodeById, ownerName])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{ownerName} · 资产目录洞察</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="map">
          <TabsList>
            <TabsTrigger value="map" className="gap-1.5">
              <BarChart3 className="h-3.5 w-3.5" /> 分布图
            </TabsTrigger>
            <TabsTrigger value="graph" className="gap-1.5">
              <Network className="h-3.5 w-3.5" /> 关系图
            </TabsTrigger>
          </TabsList>
          <TabsContent value="map" className="mt-3 h-[60vh]">
            <ResponsiveContainer width="100%" height="100%">
              <Treemap data={treemap} dataKey="size" stroke="var(--background)" fill="var(--primary)" isAnimationActive={false}>
                <Tooltip />
              </Treemap>
            </ResponsiveContainer>
          </TabsContent>
          <TabsContent value="graph" className="mt-3 h-[60vh]">
            <div className="h-full overflow-hidden rounded-lg border">
              <ReactFlow nodes={graph.rfNodes} edges={graph.edges} fitView proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false}>
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
