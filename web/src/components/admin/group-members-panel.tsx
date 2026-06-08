"use client"

// Inline asset-group membership editor — a searchable node list (members floated
// to the top) where each row toggles membership. Extracted from GroupMembersSheet
// so the unified asset console can embed it directly in the group inspector.

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Search } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { assetGroupService } from "@/lib/api/services"
import { AppIcon } from "@/components/icons/app-icon"
import { nodeIcon } from "@/lib/icons/protocol"
import { cn } from "@/lib/utils"
import type { AssetGroup, Node } from "@/lib/api/types"

export function GroupMembersPanel({
  group,
  nodes,
  onChanged,
  className,
}: {
  group: AssetGroup
  /** Full node catalogue (the console already holds it — avoids a second fetch). */
  nodes: Node[]
  onChanged?: () => void
  className?: string
}) {
  const qc = useQueryClient()
  const [members, setMembers] = React.useState<Set<number>>(() => new Set(group.node_ids ?? []))
  const [q, setQ] = React.useState("")
  React.useEffect(() => {
    setMembers(new Set(group.node_ids ?? []))
    setQ("")
  }, [group])

  const toggle = useMutation({
    mutationFn: async ({ nodeId, add }: { nodeId: number; add: boolean }) => {
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
      onChanged?.()
    },
    onError: (e: unknown, vars) => {
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
    return [...list].sort((a, b) => {
      const am = members.has(a.id) ? 0 : 1
      const bm = members.has(b.id) ? 0 : 1
      if (am !== bm) return am - bm
      return a.name.localeCompare(b.name)
    })
  }, [nodes, q, members])

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索节点 名称 / IP / 协议…"
            className="h-9 pl-8"
          />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">已选 {members.size}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded-lg border">
        <div className="p-1.5">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">没有匹配的节点</div>
          ) : (
            filtered.map((n) => {
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
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
