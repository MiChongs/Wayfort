"use client"

// The standard node-centric batch action cluster, dropped into a <BatchActionBar>
// by the workspace tree, the nodes admin tree/table, and the access-policy tree.
// Non-admins (canMutate=false) get only 导出.

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import {
  Download,
  FolderInput,
  FolderMinus,
  Power,
  PowerOff,
  ShieldPlus,
  Tag as TagIcon,
  Trash2,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { GrantWizard } from "@/components/admin/grant-wizard"
import { TagBadge } from "@/components/tags/tag-badge"
import { assetGroupService, nodeService, tagService } from "@/lib/api/services"
import { exportNodes } from "@/lib/asset-tree/export"
import type { AssetGroup, AssetTag, Node } from "@/lib/api/types"

export interface NodeBatchActionsProps {
  nodeIds: number[]
  nodes: Node[]
  groups?: AssetGroup[]
  tags?: AssetTag[]
  onChanged?: () => void
  /** false → read-only (only 导出). Workspace passes adm; admin pages pass true. */
  canMutate?: boolean
  /** When set, renders a 删除 action delegating to the caller. */
  onDelete?: () => void
}

function exportStamp(): string {
  // Browser-side stamp for the download filename (no harness Date restriction here).
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")
}

export function NodeBatchActions({
  nodeIds,
  nodes,
  groups = [],
  tags = [],
  onChanged,
  canMutate = false,
  onDelete,
}: NodeBatchActionsProps) {
  const ok = (msg: string) => {
    toast.success(msg)
    onChanged?.()
  }
  const fail = (e: { message?: string }) => toast.error("操作失败", { description: e?.message })

  const addToGroup = useMutation({
    mutationFn: (gid: number) => assetGroupService.addNodesBatch(gid, nodeIds),
    onSuccess: (r) => ok(`已加入分组${r.failed?.length ? `（${r.failed.length} 个失败）` : ""}`),
    onError: fail,
  })
  const removeFromGroup = useMutation({
    mutationFn: (gid: number) => assetGroupService.removeNodesBatch(gid, nodeIds),
    onSuccess: () => ok("已移出分组"),
    onError: fail,
  })
  const attachTag = useMutation({
    mutationFn: (tid: number) => tagService.attachBatch(tid, nodeIds),
    onSuccess: () => ok("已打标签"),
    onError: fail,
  })
  const detachTag = useMutation({
    mutationFn: (tid: number) => tagService.detachBatch(tid, nodeIds),
    onSuccess: () => ok("已去标签"),
    onError: fail,
  })
  const setDisabled = useMutation({
    mutationFn: (disabled: boolean) =>
      disabled ? nodeService.batchDisable(nodeIds) : nodeService.batchEnable(nodeIds),
    onSuccess: (_r, disabled) => ok(disabled ? "已停用" : "已启用"),
    onError: fail,
  })

  return (
    <>
      {canMutate && (
        <>
          <GrantWizard
            fixedSubjects={nodeIds.map((id) => ({ type: "node", id }))}
            onDone={onChanged}
            trigger={
              <Button variant="outline" size="sm" className="h-7 gap-1">
                <ShieldPlus className="h-3.5 w-3.5" /> 授权
              </Button>
            }
          />

          <GroupPicker
            label="加入分组"
            icon={<FolderInput className="h-3.5 w-3.5" />}
            groups={groups}
            onPick={(gid) => addToGroup.mutate(gid)}
          />
          <GroupPicker
            label="移出分组"
            icon={<FolderMinus className="h-3.5 w-3.5" />}
            groups={groups}
            onPick={(gid) => removeFromGroup.mutate(gid)}
          />

          <TagPick
            label="打标签"
            tags={tags}
            onPick={(tid) => attachTag.mutate(tid)}
          />
          <TagPick
            label="去标签"
            tags={tags}
            onPick={(tid) => detachTag.mutate(tid)}
            muted
          />

          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1"
            disabled={setDisabled.isPending}
            onClick={() => setDisabled.mutate(false)}
          >
            <Power className="h-3.5 w-3.5" /> 启用
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1"
            disabled={setDisabled.isPending}
            onClick={() => setDisabled.mutate(true)}
          >
            <PowerOff className="h-3.5 w-3.5" /> 停用
          </Button>
        </>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1">
            <Download className="h-3.5 w-3.5" /> 导出
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => exportNodes(nodes, "csv", exportStamp())}>导出 CSV</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => exportNodes(nodes, "json", exportStamp())}>导出 JSON</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {canMutate && onDelete && (
        <Button variant="outline" size="sm" className="h-7 gap-1 text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" /> 删除
        </Button>
      )}
    </>
  )
}

function GroupPicker({
  label,
  icon,
  groups,
  onPick,
}: {
  label: string
  icon: React.ReactNode
  groups: AssetGroup[]
  onPick: (groupId: number) => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1">
          {icon} {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索资产组…" />
          <CommandList>
            <CommandEmpty>没有资产组</CommandEmpty>
            <CommandGroup>
              {groups.map((g) => (
                <CommandItem
                  key={g.id}
                  value={`${g.name} ${g.path}`}
                  onSelect={() => {
                    onPick(g.id)
                    setOpen(false)
                  }}
                >
                  <span className="flex-1 truncate">{g.name}</span>
                  {g.path?.includes("/") && (
                    <span className="font-mono text-[10px] text-muted-foreground">{g.path}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TagPick({
  label,
  tags,
  onPick,
  muted,
}: {
  label: string
  tags: AssetTag[]
  onPick: (tagId: number) => void
  muted?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1">
          <TagIcon className="h-3.5 w-3.5" /> {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索标签…" />
          <CommandList>
            <CommandEmpty>没有标签</CommandEmpty>
            <CommandGroup>
              {tags.map((t) => (
                <CommandItem
                  key={t.id}
                  value={t.name}
                  onSelect={() => {
                    onPick(t.id)
                    setOpen(false)
                  }}
                  className={muted ? "opacity-90" : undefined}
                >
                  <TagBadge tag={t} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
