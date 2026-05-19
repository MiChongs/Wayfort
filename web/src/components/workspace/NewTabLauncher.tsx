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
import type { DesktopBackend } from "@/lib/desktop/types"
import { metaOf, protocolsForNode } from "./protocolMeta"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Two- or three-step launcher:
//   1. pick a node (fuzzy search of every visible asset)
//   2. pick a protocol (the protocols that node supports)
//   3. (rdp_next only) pick a backend implementation
// Steps 2 and 3 are skipped when only one option remains.
export function NewTabLauncher({ open, onOpenChange }: Props) {
  const openTab = useWorkspaceStore((s) => s.open)
  const nodes = useQuery({ queryKey: ["me", "nodes"], queryFn: meService.visibleNodes })
  const recents = useQuery({ queryKey: ["me", "recents"], queryFn: () => meService.recentNodes(20) })
  const favorites = useQuery({ queryKey: ["me", "favorites"], queryFn: meService.favorites })

  const [pickedNode, setPickedNode] = React.useState<Node | null>(null)
  // rdp_next adds a third step where the user chooses the renderer
  // backend. `pickedProtocol === "rdp_next"` is the only state that
  // triggers BackendPicker; all other protocols flow straight to
  // openTab.
  const [pickedProtocol, setPickedProtocol] = React.useState<Protocol | null>(null)
  const [q, setQ] = React.useState("")

  React.useEffect(() => {
    if (!open) {
      // Reset on close so the next invocation starts fresh.
      setPickedNode(null)
      setPickedProtocol(null)
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

  const completeOpen = (
    node: Node,
    protocol: Protocol,
    rdpBackend?: DesktopBackend,
  ) => {
    openTab({
      nodeId: node.id,
      protocol,
      rdpBackend,
      title: node.name,
      host: node.host,
      port: node.port,
    })
    onOpenChange(false)
  }

  // Bridges step 2 → step 3 when the picked protocol needs a backend
  // choice; otherwise opens immediately. Keeping the branch here (not
  // inside ProtocolPicker) lets ProtocolPicker stay protocol-agnostic.
  const onProtocolPicked = (p: Protocol) => {
    if (!pickedNode) return
    if (p === "rdp_next") {
      setPickedProtocol(p)
      return
    }
    completeOpen(pickedNode, p)
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
          ) : pickedProtocol === "rdp_next" ? (
            <BackendPicker
              node={pickedNode}
              onPick={(b) => completeOpen(pickedNode, "rdp_next", b)}
              onBack={() => setPickedProtocol(null)}
            />
          ) : (
            <ProtocolPicker
              node={pickedNode}
              onPick={onProtocolPicked}
              onBack={() => setPickedNode(null)}
            />
          )}
        </Command>
      </DialogContent>
    </Dialog>
  )

  function pickNode(n: Node) {
    const protos = protocolsForNode(n.protocol)
    if (protos.length === 1) {
      const only = protos[0]
      if (only === "rdp_next") {
        // Single protocol but needs backend choice — go directly to
        // step 3 instead of opening with no rdpBackend set.
        setPickedNode(n)
        setPickedProtocol(only)
        setQ("")
        return
      }
      completeOpen(n, only)
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

// BackendPicker — step 3 when the user has picked the `rdp_next`
// protocol. Lets them choose which renderer to mount inside
// DesktopDisplay. The three options mirror the server's
// `desktop.default_backend` enum (see configs/config.example.yaml):
//   • freerdp  — recommended; libfreerdp worker. Default.
//   • dummy    — test pattern; useful for offline UI smoke without
//                hitting the network. CI-style.
//   • ironrdp  — Wasm via Devolutions Gateway. Requires
//                `desktop.devolutions_gateway.enabled = true` on the
//                server, else the manager rejects the session with
//                "ironrdp backend not configured".
//
// We don't try to gate ironrdp on a server-side health probe here —
// the dialog stays simple and any rejection surfaces as a toast in
// DesktopDisplay's error path. That keeps the picker fast and avoids
// pre-flight API noise on every Ctrl+T.
const BACKENDS: Array<{
  key: DesktopBackend
  label: string
  description: string
  recommended?: boolean
}> = [
  {
    key: "freerdp",
    label: "FreeRDP (推荐)",
    description: "libfreerdp 子进程 + 自研 WS 帧协议;开箱即用,默认 backend",
    recommended: true,
  },
  {
    key: "ironrdp",
    label: "IronRDP",
    description:
      "@devolutions/iron-remote-desktop Wasm + Devolutions Gateway;需要 desktop.devolutions_gateway.enabled = true",
  },
  {
    key: "dummy",
    label: "Dummy (test pattern)",
    description: "进程内测试图案,不连远端 — 调试 UI 用",
  },
]

function BackendPicker({
  node,
  onPick,
  onBack,
}: {
  node: Node
  onPick: (b: DesktopBackend) => void
  onBack: () => void
}) {
  return (
    <>
      <CommandInput placeholder={`选 ${node.name} 的 RDP 后端…`} autoFocus />
      <CommandList>
        <CommandEmpty>没有可用 backend</CommandEmpty>
        <CommandGroup heading={`后端 — ${node.name} (${node.host}:${node.port})`}>
          {BACKENDS.map((b) => (
            <CommandItem
              key={b.key}
              value={`${b.label} ${b.key} ${b.description}`}
              onSelect={() => onPick(b.key)}
              className="flex items-start gap-2 py-2"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{b.label}</span>
                  {b.recommended && (
                    <span className="text-[9px] uppercase tracking-wide rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5">
                      默认
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground line-clamp-2">{b.description}</div>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup>
          <CommandItem onSelect={onBack}>← 返回协议选择</CommandItem>
        </CommandGroup>
      </CommandList>
    </>
  )
}
