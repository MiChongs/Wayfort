"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Search } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { assetGroupService, nodeService } from "@/lib/api/services"
import { AppIcon } from "@/components/icons/app-icon"
import { nodeIcon } from "@/lib/icons/protocol"
import { cn } from "@/lib/utils"
import type { AssetGroup, Node } from "@/lib/api/types"

// GroupMembersSheet — manage which nodes belong to an asset group. A single
// searchable list (members floated to the top) where each row toggles
// membership; changes call the attach/detach endpoints and refresh counts.
export function GroupMembersSheet({
  group,
  onClose,
  onChanged,
}: {
  group: AssetGroup | null
  onClose: () => void
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const open = !!group
  const allNodes = useQuery({
    queryKey: ["admin", "nodes-all"],
    queryFn: () => nodeService.list(),
    enabled: open,
  })
  const nodes = React.useMemo(() => allNodes.data?.nodes ?? [], [allNodes.data])

  const [members, setMembers] = React.useState<Set<number>>(new Set())
  const [q, setQ] = React.useState("")
  React.useEffect(() => {
    setMembers(new Set(group?.node_ids ?? []))
    setQ("")
  }, [group])

  const toggle = useMutation({
    mutationFn: async ({ nodeId, add }: { nodeId: number; add: boolean }) => {
      if (!group) return
      if (add) await assetGroupService.addNode(group.id, nodeId)
      else await assetGroupService.removeNode(group.id, nodeId)
    },
    onMutate: ({ nodeId, add }) => {
      setMembers((s) => {
        const next = new Set(s)
        if (add) next.add(nodeId)
        else next.delete(nodeId)
        return next
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "asset-groups"] })
      onChanged()
    },
    onError: (e: unknown, vars) => {
      // Roll the optimistic toggle back.
      setMembers((s) => {
        const next = new Set(s)
        if (vars.add) next.delete(vars.nodeId)
        else next.add(vars.nodeId)
        return next
      })
      toast.error("操作失败", { description: (e as Error).message })
    },
  })

  const filtered = React.useMemo(() => {
    const k = q.trim().toLowerCase()
    const list = nodes.filter((n) =>
      !k ? true : [n.name, n.host, n.protocol, n.tags].filter(Boolean).join(" ").toLowerCase().includes(k),
    )
    // Members first, then by name.
    return [...list].sort((a, b) => {
      const am = members.has(a.id) ? 0 : 1
      const bm = members.has(b.id) ? 0 : 1
      if (am !== bm) return am - bm
      return a.name.localeCompare(b.name)
    })
  }, [nodes, q, members])

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle>管理成员 · {group?.name}</SheetTitle>
          <SheetDescription>
            已选 {members.size} 个节点 · 点击行即可加入 / 移出
          </SheetDescription>
        </SheetHeader>

        <div className="border-b px-4 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索节点 名称 / IP / 协议…"
              className="h-9 pl-8"
            />
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2">
            {allNodes.isLoading && (
              <div className="py-10 text-center text-sm text-muted-foreground">加载节点…</div>
            )}
            {!allNodes.isLoading && filtered.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">没有匹配的节点</div>
            )}
            {filtered.map((n: Node) => {
              const on = members.has(n.id)
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => toggle.mutate({ nodeId: n.id, add: !on })}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                    on ? "bg-primary/[0.06]" : "hover:bg-accent/60",
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground">
                    <AppIcon icon={nodeIcon(n)} size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{n.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {n.host}:{n.port}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                </button>
              )
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
