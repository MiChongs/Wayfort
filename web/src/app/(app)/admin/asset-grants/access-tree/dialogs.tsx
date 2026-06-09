"use client"

// 复制 / 模板:从另一个对象或模板克隆整棵目录、把当前对象的目录存为模板。
// 命令面板(cmdk ⌘K):快速「把某资产加到当前文件夹」「跳到某文件夹」。

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Copy, FolderInput, FolderTree, Save, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { accessTreeService } from "@/lib/api/services"
import { nodeIcon } from "@/lib/icons/protocol"
import { AppIcon } from "@/components/icons/app-icon"
import type { GranteeKind, Node } from "@/lib/api/types"
import type { Owner, OwnerCat } from "./tree-model"

// Local command palette dialog (the shadcn command.tsx here doesn't ship one).
function CommandDialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>命令面板</DialogTitle>
        </DialogHeader>
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  )
}

export function CopyMenu({ owner, ownerCats, onDone }: { owner: Owner; ownerCats: OwnerCat[]; onDone: () => void }) {
  const qc = useQueryClient()
  const [mode, setMode] = React.useState<null | "from-object" | "from-template" | "save-template">(null)

  const clone = useMutation({
    mutationFn: (from: { type: GranteeKind | "template"; id: number }) =>
      accessTreeService.clone({ from_owner_type: from.type, from_owner_id: from.id, to_owner_type: owner.type, to_owner_id: owner.id }),
    onSuccess: () => {
      setMode(null)
      onDone()
      toast.success("已复制目录到此对象")
    },
    onError: (e: Error) => toast.error("复制失败", { description: e.message }),
  })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Copy className="h-3.5 w-3.5" /> 复制 / 模板
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setMode("from-object")}>
            <FolderInput className="h-4 w-4" /> 从其他对象复制目录
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMode("from-template")}>
            <FolderTree className="h-4 w-4" /> 从模板套用
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setMode("save-template")}>
            <Save className="h-4 w-4" /> 把当前目录存为模板
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 从对象复制 */}
      <CommandDialog open={mode === "from-object"} onOpenChange={(v) => !v && setMode(null)}>
        <CommandInput placeholder="选择来源对象（其整棵目录将复制过来）…" />
        <CommandList>
          <CommandEmpty>没有匹配项</CommandEmpty>
          {ownerCats.map((c) => (
            <CommandGroup key={c.key} heading={c.label}>
              {c.items
                .filter((i) => !(c.key === owner.type && i.id === owner.id))
                .map((i) => (
                  <CommandItem key={`${c.key}:${i.id}`} value={`${c.label} ${i.name}`} onSelect={() => clone.mutate({ type: c.key, id: i.id })}>
                    {i.name}
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>

      <FromTemplateDialog open={mode === "from-template"} onOpenChange={(v) => !v && setMode(null)} onPick={(id) => clone.mutate({ type: "template", id })} />
      <SaveTemplateDialog open={mode === "save-template"} onOpenChange={(v) => !v && setMode(null)} owner={owner} onSaved={() => { setMode(null); void qc.invalidateQueries({ queryKey: ["access-templates"] }) }} />
    </>
  )
}

function FromTemplateDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (v: boolean) => void; onPick: (id: number) => void }) {
  const qc = useQueryClient()
  const templates = useQuery({ queryKey: ["access-templates"], queryFn: accessTreeService.listTemplates, enabled: open })
  const del = useMutation({
    mutationFn: (id: number) => accessTreeService.removeTemplate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["access-templates"] })
      toast.success("模板已删除")
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })
  const list = templates.data?.templates ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>从模板套用</DialogTitle>
        </DialogHeader>
        {list.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">还没有模板。可在任意对象上「存为模板」。</p>
        ) : (
          <div className="max-h-[50vh] space-y-1 overflow-y-auto">
            {list.map((t) => (
              <div key={t.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                <FolderTree className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.name}</div>
                  {t.description ? <div className="truncate text-xs text-muted-foreground">{t.description}</div> : null}
                </div>
                <Button size="sm" onClick={() => onPick(t.id)}>套用</Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => del.mutate(t.id)}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SaveTemplateDialog({ open, onOpenChange, owner, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; owner: Owner; onSaved: () => void }) {
  const [name, setName] = React.useState("")
  const [desc, setDesc] = React.useState("")
  React.useEffect(() => {
    if (open) {
      setName(`${owner.name} 的目录模板`)
      setDesc("")
    }
  }, [open, owner.name])
  const save = useMutation({
    mutationFn: () => accessTreeService.createTemplate({ name: name.trim(), description: desc, from_owner_type: owner.type, from_owner_id: owner.id }),
    onSuccess: () => {
      toast.success("已存为模板")
      onSaved()
    },
    onError: (e: Error) => toast.error("保存失败", { description: e.message }),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>把「{owner.name}」的目录存为模板</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">模板名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">说明（可选）</Label>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="如：运维标准目录" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- ⌘K command palette ----

export function CommandPalette({
  open,
  onOpenChange,
  nodes,
  folders,
  onAddToTarget,
  onJumpFolder,
  targetName,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  nodes: Node[]
  folders: { id: number; name: string }[]
  onAddToTarget: (nodeId: number) => void
  onJumpFolder: (id: number) => void
  targetName?: string
}) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={targetName ? `把资产加到「${targetName}」，或跳到文件夹…` : "先选一个文件夹…"} />
      <CommandList>
        <CommandEmpty>没有匹配项</CommandEmpty>
        <CommandGroup heading="加入资产">
          {nodes.slice(0, 200).map((n) => (
            <CommandItem
              key={`n${n.id}`}
              value={`资产 ${n.name} ${n.host}`}
              onSelect={() => {
                onAddToTarget(n.id)
                onOpenChange(false)
              }}
            >
              <AppIcon icon={nodeIcon(n)} size={14} className="mr-2" />
              <span className="flex-1">{n.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{n.host}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="跳到文件夹">
          {folders.map((f) => (
            <CommandItem
              key={`f${f.id}`}
              value={`文件夹 ${f.name}`}
              onSelect={() => {
                onJumpFolder(f.id)
                onOpenChange(false)
              }}
            >
              <FolderTree className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
              {f.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
