"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { meService } from "@/lib/api/services"
import type { Node } from "@/lib/api/types"
import { metaOf, protocolsForNode } from "./protocolMeta"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Two-step launcher:
//   1. pick a node (fuzzy search of every visible asset)
//   2. pick a protocol (the protocols that node supports)
// Step 2 is skipped when the node only supports a single protocol.
export function NewTabLauncher({ open, onOpenChange }: Props) {
  const openTab = useWorkspaceStore((s) => s.open)
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const recents = useQuery({ queryKey: ["me", "recents"], queryFn: () => meService.recentNodes(20) })
  const favorites = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })

  const [pickedNode, setPickedNode] = React.useState<Node | null>(null)
  const [q, setQ] = React.useState("")

  React.useEffect(() => {
    if (!open) {
      // Reset on close so the next invocation starts fresh.
      setPickedNode(null)
      setQ("")
    }
  }, [open])

  const all: Node[] = nodes.data?.nodes ?? []
  const byId = React.useMemo(() => new Map(all.map((n) => [n.id, n])), [all])
  const favIds = new Set(favorites.data?.node_ids ?? [])
  const recentOrdered = (recents.data?.recent ?? [])
    .map((r) => byId.get(r.node_id))
    .filter((n): n is Node => !!n)

  const enabled = all.filter((n) => !n.disabled)

  const completeOpen = (node: Node, protocol: Protocol) => {
    openTab({
      nodeId: node.id,
      protocol,
      title: node.name,
      host: node.host,
      port: node.port,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 overflow-hidden max-w-xl">
        <DialogTitle className="sr-only">新建工作台 Tab</DialogTitle>
        <Command shouldFilter>
          {!pickedNode ? (
            <>
              <CommandInput
                value={q}
                onValueChange={setQ}
                placeholder="按名称 / IP / 描述搜索节点…"
                autoFocus
              />
              <CommandList className="max-h-[60vh]">
                <CommandEmpty>没有匹配的节点</CommandEmpty>
                {recentOrdered.length > 0 && (
                  <>
                    <CommandGroup heading="最近访问">
                      {recentOrdered.slice(0, 6).map((n) => (
                        <NodeRow key={`recent-${n.id}`} node={n} fav={favIds.has(n.id)} onPick={pickNode} />
                      ))}
                    </CommandGroup>
                    <CommandSeparator />
                  </>
                )}
                <CommandGroup heading="全部资产">
                  {enabled.map((n) => (
                    <NodeRow key={n.id} node={n} fav={favIds.has(n.id)} onPick={pickNode} />
                  ))}
                </CommandGroup>
              </CommandList>
            </>
          ) : (
            <ProtocolPicker node={pickedNode} onPick={(p) => completeOpen(pickedNode, p)} onBack={() => setPickedNode(null)} />
          )}
        </Command>
      </DialogContent>
    </Dialog>
  )

  function pickNode(n: Node) {
    const protos = protocolsForNode(n.protocol)
    if (protos.length === 1) {
      completeOpen(n, protos[0])
      return
    }
    setPickedNode(n)
    setQ("")
  }
}

function NodeRow({ node, fav, onPick }: { node: Node; fav: boolean; onPick: (n: Node) => void }) {
  const protos = protocolsForNode(node.protocol)
  const meta = metaOf(protos[0])
  const Icon = meta.icon
  return (
    <CommandItem
      value={`${node.name} ${node.host} ${node.protocol} ${node.tags ?? ""} ${node.description ?? ""}`}
      onSelect={() => onPick(node)}
      className="flex items-center gap-2"
    >
      <Icon className={`w-4 h-4 ${meta.tint}`} />
      <span className="font-medium truncate flex-1">{node.name}</span>
      {fav && <span className="text-[10px] text-amber-500">★</span>}
      <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[12rem]">
        {node.host}:{node.port}
      </span>
      <span className="text-[10px] text-muted-foreground uppercase">{node.protocol}</span>
    </CommandItem>
  )
}

function ProtocolPicker({
  node,
  onPick,
  onBack,
}: {
  node: Node
  onPick: (p: Protocol) => void
  onBack: () => void
}) {
  const protos = protocolsForNode(node.protocol)
  return (
    <>
      <CommandInput placeholder={`选一个协议打开 ${node.name}…`} autoFocus />
      <CommandList>
        <CommandEmpty>没有可用协议</CommandEmpty>
        <CommandGroup heading={`协议 — ${node.name} (${node.host}:${node.port})`}>
          {protos.map((p) => {
            const meta = metaOf(p)
            const Icon = meta.icon
            return (
              <CommandItem
                key={p}
                value={`${meta.label} ${p}`}
                onSelect={() => onPick(p)}
                className="flex items-center gap-2"
              >
                <Icon className={`w-4 h-4 ${meta.tint}`} />
                {meta.label}
              </CommandItem>
            )
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup>
          <CommandItem onSelect={onBack}>← 返回节点选择</CommandItem>
        </CommandGroup>
      </CommandList>
    </>
  )
}
