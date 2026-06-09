"use client"

// 资产库:分面筛选(协议/标签/区域) + fuse.js 模糊搜索 + 悬浮详情卡 +
// shift 连选 / 全选筛选结果 + react-virtuoso 虚拟化 + 每行可拖入左侧文件夹。

import * as React from "react"
import { useDraggable } from "@dnd-kit/core"
import { Virtuoso } from "react-virtuoso"
import Fuse from "fuse.js"
import { Check, ChevronRight, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { AppIcon } from "@/components/icons/app-icon"
import { nodeIcon } from "@/lib/icons/protocol"
import type { DragData } from "./tree-model"
import type { Node } from "@/lib/api/types"

export function AssetLibrary({
  nodes,
  placed,
  target,
  targetName,
  onAdd,
}: {
  nodes: Node[]
  placed: Set<number>
  target: number | null
  targetName?: string
  onAdd: (nodeIds: number[]) => void
}) {
  const [q, setQ] = React.useState("")
  const [proto, setProto] = React.useState<string | null>(null)
  const [tag, setTag] = React.useState<string | null>(null)
  const [checked, setChecked] = React.useState<Set<number>>(new Set())
  const lastIdx = React.useRef<number | null>(null)

  const protocols = React.useMemo(() => [...new Set(nodes.map((n) => n.protocol))].sort(), [nodes])
  const tags = React.useMemo(() => {
    const s = new Set<string>()
    for (const n of nodes) (n.tags || "").split(",").map((t) => t.trim()).filter(Boolean).forEach((t) => s.add(t))
    return [...s].sort()
  }, [nodes])

  const fuse = React.useMemo(
    () => new Fuse(nodes, { keys: ["name", "host", "protocol", "tags", "region", "description"], threshold: 0.4, ignoreLocation: true }),
    [nodes],
  )

  const filtered = React.useMemo(() => {
    let base = q.trim() ? fuse.search(q.trim()).map((r) => r.item) : nodes
    if (proto) base = base.filter((n) => n.protocol === proto)
    if (tag) base = base.filter((n) => (n.tags || "").split(",").map((t) => t.trim()).includes(tag))
    return base
  }, [nodes, q, proto, tag, fuse])

  const toggle = (id: number, idx: number, shift: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (shift && lastIdx.current != null) {
        const [a, b] = [lastIdx.current, idx].sort((x, y) => x - y)
        for (let i = a; i <= b; i++) next.add(filtered[i].id)
      } else {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      return next
    })
    lastIdx.current = idx
  }
  const allFilteredChecked = filtered.length > 0 && filtered.every((n) => checked.has(n.id))

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground">资产库</span>
          <button
            type="button"
            className="text-[11px] text-primary hover:underline"
            onClick={() => setChecked(allFilteredChecked ? new Set() : new Set(filtered.map((n) => n.id)))}
          >
            {allFilteredChecked ? "取消全选" : "全选筛选结果"}
          </button>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="模糊搜索 名称 / IP / 标签…" className="h-8 pl-7 text-sm" />
        </div>
        {(protocols.length > 1 || tags.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {protocols.map((p) => (
              <FacetChip key={p} on={proto === p} onClick={() => setProto(proto === p ? null : p)}>
                {p.toUpperCase()}
              </FacetChip>
            ))}
            {tags.slice(0, 8).map((t) => (
              <FacetChip key={t} on={tag === t} tone="tag" onClick={() => setTag(tag === t ? null : t)}>
                {t}
              </FacetChip>
            ))}
            {(proto || tag) && (
              <button type="button" onClick={() => { setProto(null); setTag(null) }} className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" /> 清除
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">没有匹配的资产</div>
        ) : (
          <Virtuoso
            style={{ height: "100%" }}
            data={filtered}
            itemContent={(idx, n) => (
              <div className="px-2">
                <LibRow node={n} checked={checked.has(n.id)} placed={placed.has(n.id)} onToggle={(shift) => toggle(n.id, idx, shift)} />
              </div>
            )}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2.5">
        <span className="text-xs text-muted-foreground">已选 {checked.size}</span>
        <Button
          size="sm"
          disabled={checked.size === 0 || target == null}
          title={target == null ? "先在左侧选择文件夹" : undefined}
          onClick={() => {
            onAdd([...checked])
            setChecked(new Set())
          }}
        >
          <ChevronRight className="h-3.5 w-3.5" /> {targetName ? `加入「${targetName}」` : "加入目录"}
        </Button>
      </div>
    </div>
  )
}

function FacetChip({ children, on, onClick, tone }: { children: React.ReactNode; on: boolean; onClick: () => void; tone?: "tag" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
        !on && tone === "tag" && "text-muted-foreground",
      )}
    >
      {children}
    </button>
  )
}

function LibRow({ node, checked, placed, onToggle }: { node: Node; checked: boolean; placed: boolean; onToggle: (shift: boolean) => void }) {
  const drag = useDraggable({ id: `lib:${node.id}`, data: { kind: "lib", nodeId: node.id, label: node.name } satisfies DragData })
  return (
    <HoverCard openDelay={250} closeDelay={60}>
      <HoverCardTrigger asChild>
        <div
          ref={drag.setNodeRef}
          {...drag.listeners}
          {...drag.attributes}
          className={cn(
            "my-0.5 flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent active:cursor-grabbing",
            drag.isDragging && "opacity-40",
          )}
        >
          <span onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <Checkbox checked={checked} onClick={(e) => onToggle((e as React.MouseEvent).shiftKey)} />
          </span>
          <AppIcon icon={nodeIcon(node)} size={14} className="shrink-0" />
          <span className="flex-1 truncate">{node.name}</span>
          {placed ? (
            <Badge variant="outline" className="shrink-0 gap-0.5 font-normal text-[10px] text-muted-foreground">
              <Check className="h-2.5 w-2.5" /> 已在目录
            </Badge>
          ) : null}
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{node.host}</span>
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="left" align="start" className="w-64 text-xs">
        <div className="flex items-center gap-2">
          <AppIcon icon={nodeIcon(node)} size={18} />
          <span className="font-medium">{node.name}</span>
          <Badge variant="secondary" className="ml-auto font-normal text-[10px]">{node.protocol.toUpperCase()}</Badge>
        </div>
        <dl className="mt-2 space-y-1">
          <Row k="地址" v={`${node.host}:${node.port}`} mono />
          {node.username ? <Row k="账号" v={node.username} mono /> : null}
          {node.credential_name ? <Row k="凭据" v={node.credential_name} /> : null}
          {node.region ? <Row k="区域" v={node.region} /> : null}
          {node.proxy_names?.length ? <Row k="代理链" v={node.proxy_names.join(" → ")} /> : null}
          {node.tags ? <Row k="标签" v={node.tags} /> : null}
        </dl>
      </HoverCardContent>
    </HoverCard>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-10 shrink-0 text-muted-foreground">{k}</dt>
      <dd className={cn("min-w-0 flex-1 truncate", mono && "font-mono")}>{v}</dd>
    </div>
  )
}
