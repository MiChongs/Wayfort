"use client"

// A cmdk-style quick switcher over the asset set: open it, type, jump. Reused by
// the workspace tree (Cmd/Ctrl-K) so finding one of hundreds of assets never
// means scrolling the tree.

import * as React from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { AppIcon } from "@/components/icons/app-icon"
import { nodeIcon } from "@/lib/icons/protocol"
import type { Node } from "@/lib/api/types"

export function AssetCommandPalette({
  nodes,
  onSelect,
  hotkey = "mod+k",
}: {
  nodes: Node[]
  onSelect: (node: Node) => void
  hotkey?: string
}) {
  const [open, setOpen] = React.useState(false)

  useHotkeys(
    hotkey,
    (e) => {
      e.preventDefault()
      setOpen((v) => !v)
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
    [],
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">资产快速切换</DialogTitle>
        <Command
          filter={(value, search) =>
            value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder="搜索资产：名称 / 主机 / 标签 / 协议…" />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty>没有匹配的资产</CommandEmpty>
            <CommandGroup heading={`资产（${nodes.length}）`}>
              {nodes.map((n) => (
                <CommandItem
                  key={n.id}
                  value={`${n.name} ${n.host}:${n.port} ${n.tags ?? ""} ${n.protocol}`}
                  onSelect={() => {
                    onSelect(n)
                    setOpen(false)
                  }}
                  className="gap-2"
                >
                  <AppIcon icon={nodeIcon(n)} className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{n.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{n.host}:{n.port}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{n.protocol}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
