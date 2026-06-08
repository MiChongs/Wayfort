"use client"

// Right-panel inspector for a selected asset group in the console: membership
// (inline GroupMembersPanel), authorization (assign the whole group to users +
// who-can-access), and settings (rename / description / new subgroup / delete).

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderTree, FolderPlus, ShieldPlus, Trash2 } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GrantWizard, useGrantDirectories } from "@/components/admin/grant-wizard"
import { GroupMembersPanel } from "@/components/admin/group-members-panel"
import { confirmDialog } from "@/components/common/confirm-dialog"
import {
  ActionChips,
  ValidityCell,
  GRANTEE_KIND_LABEL,
  granteeNameFrom,
} from "@/lib/access/grant-display"
import { assetGroupService, grantService } from "@/lib/api/services"
import type { AssetGroup, Node } from "@/lib/api/types"

export function GroupInspector({
  group,
  nodes,
  directCount,
  subtreeCount,
  onNewSubgroup,
  onDeleted,
  onChanged,
}: {
  group: AssetGroup
  nodes: Node[]
  directCount: number
  subtreeCount: number
  onNewSubgroup: (parentId: number) => void
  onDeleted?: () => void
  onChanged?: () => void
}) {
  const qc = useQueryClient()
  const { granteeCats } = useGrantDirectories()
  const granteeName = React.useMemo(
    () => granteeNameFrom((t, id) => granteeCats.find((c) => c.key === t)?.items.find((i) => i.id === id)?.name),
    [granteeCats],
  )

  const [name, setName] = React.useState(group.name)
  const [desc, setDesc] = React.useState(group.description ?? "")
  React.useEffect(() => {
    setName(group.name)
    setDesc(group.description ?? "")
  }, [group])

  const grants = useQuery({ queryKey: ["admin", "grants"], queryFn: grantService.list })
  const groupGrants = React.useMemo(
    () => (grants.data?.grants ?? []).filter((g) => g.subject_type === "group" && g.subject_id === group.id),
    [grants.data, group.id],
  )

  const save = useMutation({
    mutationFn: () => assetGroupService.update(group.id, { name: name.trim() || group.name, description: desc }),
    onSuccess: () => {
      toast.success("已保存")
      onChanged?.()
    },
    onError: (e: Error) => toast.error("保存失败", { description: e.message }),
  })
  const remove = useMutation({
    mutationFn: () => assetGroupService.remove(group.id),
    onSuccess: () => {
      toast.success("已删除（子组上提一级）")
      onDeleted?.()
    },
    onError: (e: Error) => toast.error("删除失败", { description: e.message }),
  })
  const revoke = useMutation({
    mutationFn: (id: number) => grantService.remove(id),
    onSuccess: () => {
      toast.success("已撤销")
      qc.invalidateQueries({ queryKey: ["admin", "grants"] })
      onChanged?.()
    },
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FolderTree className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{group.name}</h2>
          <p className="text-xs text-muted-foreground">
            直接成员 {directCount} · 含子组 {subtreeCount}
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 gap-1" onClick={() => onNewSubgroup(group.id)}>
          <FolderPlus className="h-3.5 w-3.5" /> 新建子组
        </Button>
      </div>

      <Tabs defaultValue="members" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-5 mt-3 w-fit">
          <TabsTrigger value="members">成员</TabsTrigger>
          <TabsTrigger value="grants">授权 {groupGrants.length ? `· ${groupGrants.length}` : ""}</TabsTrigger>
          <TabsTrigger value="settings">设置</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-hidden px-5 py-3">
          <TabsContent value="members" className="mt-0 flex h-full min-h-0 flex-col">
            <GroupMembersPanel group={group} nodes={nodes} onChanged={onChanged} className="h-full" />
          </TabsContent>

          <TabsContent value="grants" className="mt-0 space-y-3 overflow-y-auto">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">把整组资产分配给</span>
              <GrantWizard
                fixedSubject={{ type: "group", id: group.id, name: group.name }}
                onDone={() => qc.invalidateQueries({ queryKey: ["admin", "grants"] })}
                trigger={<Button size="sm" className="gap-1"><ShieldPlus className="h-3.5 w-3.5" /> 分配给用户</Button>}
              />
            </div>
            {groupGrants.length === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                还没有把这个组分配给任何人。
              </div>
            ) : (
              <div className="divide-y rounded-lg border">
                {groupGrants.map((g) => (
                  <div key={g.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <Badge variant="outline" className="font-normal">{GRANTEE_KIND_LABEL[g.grantee_type]}</Badge>
                    <span className="font-medium">{granteeName(g.grantee_type, g.grantee_id)}</span>
                    <ActionChips actions={g.actions.split(",").filter(Boolean)} />
                    <div className="ml-auto flex items-center gap-2">
                      <ValidityCell to={g.valid_to} />
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        onClick={async () => {
                          if (await confirmDialog({ title: "撤销这条授权？", destructive: true })) revoke.mutate(g.id)
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="settings" className="mt-0 space-y-4 overflow-y-auto">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">描述</Label>
              <Textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="这个资产组是做什么的" />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>保存</Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1 text-destructive hover:text-destructive"
                onClick={async () => {
                  if (await confirmDialog({ title: `删除资产组「${group.name}」？`, description: "组内节点不会被删除，只解除分组；直接子组自动上提一级。", destructive: true })) remove.mutate()
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> 删除资产组
              </Button>
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
